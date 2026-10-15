import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DON, type Directive } from "donly";
import { ensureCerts } from "./certs";
import { curl } from "./tunnel/curl/curl";
import { Semaphore } from "./semaphore";
import { nodeRequest } from "./tunnel/node/node";
import type { Engine } from "./tunnel/remote";
import { sshRequest } from "./tunnel/ssh/ssh";
import { kubectlRequest } from "./tunnel/kubectl/kubectl";
import type { ConsoleEntry } from "./tunnel/types";
import { socksHandshake, targetName } from "./socks";
import { createLogger_experimental, type CommandTransaction, type RequestTransaction } from "./logger";

type Command = "curl" | "node" | "ssh" | "kubectl";

export interface Route {
  /** `null` matches any method. */
  method: string | null;
  /** Tested against the full request URL, e.g. `https://example.com/path`. */
  pattern: RegExp;
  action:
    | { kind: "respond"; status: number; body: string }
    | { kind: "proxy_pass"; target: URL }
    | { kind: "command_pass"; command: Command; engine?: Engine; concurrency: number; args: string[]; engineArgs?: string[]; podMatch?: { glob: string; selectors: string[] }; password?: string };
}

/** One `listen` (or `port`) of the `proxy` block. */
export interface ListenerConfig {
  host: string;
  port: number;
  /** Set when this listener itself speaks TLS (`listen https`). */
  https?: { cert: string; key: string };
  /** Set by `listen socks4` / `listen socks5`: the listener speaks that SOCKS version instead of HTTP. */
  socks?: 4 | 5;
}

export interface ProxyConfig {
  /** Every `listen`/`port` of the block, in order; they share the routes and the log. At least one. */
  listeners: ListenerConfig[];
  /** Host, port and TLS of the first listener (kept for single-listener callers). */
  host: string;
  port: number;
  /** Deprecated top-level `ssl`: certificate that terminates the TLS of `CONNECT` tunnels. */
  ssl: { cert: string; key: string };
  /** Set by `listen https [host] N [{ ssl { ... } }]`: the proxy listener itself speaks TLS with this certificate. */
  https?: { cert: string; key: string };
  routes: Route[];
  /** Absolute path of the `.ndjson` transaction log, if configured. */
  logFile?: string;
}

/** `no_warnings` inside a `command_pass node` (or `no_warnings true`): it becomes `--no-warnings`. */
const noWarningsArgs = (name: string, command: string, directive: Directive): string[] => {
  const noWarnings = directive.children.find((c) => c.name === "no_warnings");
  if (!noWarnings) return [];
  if (command !== "node") throw new Error(`route ${name}: no_warnings solo aplica a command_pass node`);
  const value = noWarnings.args[0] ?? true;
  if (typeof value !== "boolean") throw new Error(`route ${name}: no_warnings debe ser true o false, no "${value}"`);
  return value ? ["--no-warnings"] : [];
};

/** `max_time <seconds>` inside a `command_pass curl`: it becomes `--max-time <seconds>`. */
const maxTimeArgs = (name: string, command: string, directive: Directive): string[] => {
  const maxTime = directive.children.find((c) => c.name === "max_time");
  if (!maxTime) return [];
  if (command !== "curl") throw new Error(`route ${name}: max_time solo aplica a command_pass curl`);
  const value = maxTime.args[0];
  if (!(typeof value === "number" && value > 0)) {
    throw new Error(`route ${name}: max_time debe ser un número positivo, no "${value}"`);
  }
  return ["--max-time", String(value)];
};

/** `insecure` inside a `command_pass curl` (or `insecure true`): it becomes `--insecure`. */
const insecureArgs = (name: string, command: string, directive: Directive): string[] => {
  const insecure = directive.children.find((c) => c.name === "insecure");
  if (!insecure) return [];
  if (command !== "curl") throw new Error(`route ${name}: insecure solo aplica a command_pass curl`);
  const value = insecure.args[0] ?? true;
  if (typeof value !== "boolean") throw new Error(`route ${name}: insecure debe ser true o false, no "${value}"`);
  return value ? ["--insecure"] : [];
};

/** `retry <n>` inside a `command_pass curl`: it becomes `--retry <n>`. */
const retryArgs = (name: string, command: string, directive: Directive): string[] => {
  const retry = directive.children.find((c) => c.name === "retry");
  if (!retry) return [];
  if (command !== "curl") throw new Error(`route ${name}: retry solo aplica a command_pass curl`);
  const value = retry.args[0];
  if (!(typeof value === "number" && Number.isInteger(value) && value >= 0)) {
    throw new Error(`route ${name}: retry debe ser un entero no negativo, no "${value}"`);
  }
  return ["--retry", String(value)];
};

/** Options from the child directives of a `command_pass`: `extra_args <value…>`, `no_warnings`, `insecure`, `max_time`, then `retry`. */
const optionArgs = (name: string, command: string, directive: Directive): string[] => [
  ...directive.children.filter((c) => c.name === "extra_args").flatMap((c) => c.args.map(String)),
  ...noWarningsArgs(name, command, directive),
  ...insecureArgs(name, command, directive),
  ...maxTimeArgs(name, command, directive),
  ...retryArgs(name, command, directive),
];

/** `context <name>` and `namespace <name>` (alias `namespaces`) inside a `kubectl_pass` / `command_pass kubectl`: they become `--context` / `--namespace`. */
const selectorArgs = (name: string, directive: Directive, command = "kubectl"): string[] =>
  (["context", "namespace"] as const).flatMap((selector) => {
    const child = directive.children.find((c) => c.name === selector || (selector === "namespace" && c.name === "namespaces"));
    if (!child) return [];
    if (command !== "kubectl") throw new Error(`route ${name}: ${selector} solo aplica a kubectl_pass y command_pass kubectl`);
    const value = child.args[0];
    if (typeof value !== "string" || value === "") {
      throw new Error(`route ${name}: ${selector} debe ser un nombre, no "${value}"`);
    }
    return [`--${selector}`, value];
  });

/**
 * The arguments of a `command_pass`: those of its line plus the options of its child directives.
 * `ssh` and `kubectl` keep their target (the last argument of the line) last.
 */
const commandPassArgs = (name: string, directive: Directive): string[] => {
  const command = String(directive.args[0]);
  const args = directive.args.slice(1).map(String);
  const options = optionArgs(name, command, directive);
  if (command !== "ssh" && command !== "kubectl") return [...args, ...options];
  const selectors = selectorArgs(name, directive, command);
  return [...args.slice(0, -1), ...options, ...selectors, args.at(-1)!];
};

/** `port`, `user` and `pass` inside an `ssh_pass`: `-p <port>`, `-l <user>` and the password for askpass. */
const sshPassOptions = (name: string, directive: Directive) => {
  const value = (key: string) => directive.children.find((c) => c.name === key)?.args[0];
  const port = value("port");
  const user = value("user");
  const pass = value("pass");
  if (port !== undefined && !(typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535)) {
    throw new Error(`route ${name}: port debe ser un puerto entre 1 y 65535, no "${port}"`);
  }
  if (user !== undefined && (typeof user !== "string" || user === "")) {
    throw new Error(`route ${name}: user debe ser un nombre, no "${user}"`);
  }
  if (pass !== undefined && !((typeof pass === "string" && pass !== "") || typeof pass === "number")) {
    throw new Error(`route ${name}: pass debe ser un texto no vacío`);
  }
  return {
    options: [...(port === undefined ? [] : ["-p", String(port)]), ...(user === undefined ? [] : ["-l", user])],
    password: pass === undefined ? undefined : String(pass),
  };
};

const defaultManifest = new URL("../../manifest.donly", import.meta.url);

/** Reads the `proxy { ... }` block of a `.donly` manifest. */
export const loadConfig = async (
  manifest: string | URL = defaultManifest,
): Promise<ProxyConfig> => {
  const url = typeof manifest === "string" ? pathToFileURL(manifest) : manifest;
  const root = DON.parse(await readFile(url, "utf8"));
  const proxy = root.name === "proxy" ? root : root.children.find((c) => c.name === "proxy");
  const child = (name: string, parent = proxy) => parent?.children.find((c) => c.name === name);
  const resolve = (p: string) => fileURLToPath(new URL(p, url));
  const ssl = child("ssl");
  // `listen [http|https] [host] port [{ ssl { cert, key } }]`, repeatable; `port` is an alias of `listen`
  // (`port 8080` = `listen http 8080`) and `host` is the default host.
  const listenDirectives = proxy?.children.filter((c) => c.name === "listen") ?? [];
  const portDirectives = proxy?.children.filter((c) => c.name === "port") ?? [];
  if (listenDirectives.length > 0 && portDirectives.length > 0) throw new Error("listen y port no se pueden declarar a la vez: port es un alias de listen");
  const endpoints = listenDirectives.length > 0 ? listenDirectives : portDirectives;
  const defaultHost = String(child("host")?.args[0] ?? "127.0.0.1");
  const listeners = (endpoints.length > 0 ? endpoints : [undefined]).map((endpoint): ListenerConfig => {
    const name = listenDirectives.length > 0 ? "listen" : "port";
    const endpointArgs = [...(endpoint?.args ?? [])];
    const scheme = typeof endpointArgs[0] === "string" && ["http", "https", "socks4", "socks5"].includes(endpointArgs[0]) ? String(endpointArgs.shift()) : "http";
    const portValue = endpointArgs.pop() ?? 0;
    if (typeof portValue !== "number") throw new Error(`${name}: el puerto debe ser un número, no "${portValue}"`);
    const listenHost = endpointArgs.shift();
    if (endpointArgs.length > 0) throw new Error(`${name}: se esperaba [http|https|socks4|socks5] [host] puerto`);
    const listenSsl = endpoint && child("ssl", endpoint);
    return {
      host: String(listenHost ?? defaultHost),
      port: portValue,
      https:
        scheme === "https"
          ? {
              cert: resolve(String(child("cert", listenSsl)?.args[0] ?? "./certs/cert.pem")),
              key: resolve(String(child("key", listenSsl)?.args[0] ?? "./certs/key.pem")),
            }
          : undefined,
      socks: scheme === "socks4" ? 4 : scheme === "socks5" ? 5 : undefined,
    };
  });
  const seen = new Set<string>();
  for (const { host, port } of listeners) {
    if (port === 0) continue;
    const key = `${host}:${port}`;
    if (seen.has(key)) throw new Error(`listen: ${key} está declarado más de una vez`);
    seen.add(key);
  }
  const logFile = child("log_file")?.args[0];
  if (logFile !== undefined && !String(logFile).endsWith(".ndjson")) {
    throw new Error(`log_file ${logFile}: solo se soporta la extensión .ndjson`);
  }

  return {
    listeners,
    host: listeners[0]!.host,
    port: listeners[0]!.port,
    ssl: {
      cert: resolve(String(child("cert", ssl)?.args[0] ?? "./certs/cert.pem")),
      key: resolve(String(child("key", ssl)?.args[0] ?? "./certs/key.pem")),
    },
    https: listeners[0]!.https,
    logFile: logFile === undefined ? undefined : resolve(String(logFile)),
    routes: (proxy?.children ?? [])
      .filter((c) => c.name === "route")
      .map((route): Route => {
        const name = route.args.join(" ");
        const respond = child("respond", route);
        const proxyPass = child("proxy_pass", route);
        const commandPass = child("command_pass", route);
        const kubectlPass = child("kubectl_pass", route);
        const sshPass = child("ssh_pass", route);
        if ([respond, proxyPass, commandPass, kubectlPass, sshPass].filter(Boolean).length !== 1) {
          throw new Error(
            `route ${name}: se requiere exactamente uno de \`respond\`, \`proxy_pass\`, \`command_pass\`, \`kubectl_pass\` o \`ssh_pass\``,
          );
        }
        const method = route.args.length > 1 ? String(route.args[0]).toUpperCase() : null;
        // `route { … }` without arguments matches every request.
        const pattern = route.args.length === 0 ? /(?:)/ : new RegExp(String(route.args[route.args.length - 1]));
        const pass = kubectlPass ?? sshPass;
        if (pass) {
          // kubectl_pass <kubectl options…> <target> { command_pass <curl|wget|node> [options…] }
          // ssh_pass <ssh options…> <destination> { command_pass <curl|wget|node> [options…] }
          const directive = kubectlPass ? "kubectl_pass" : "ssh_pass";
          const command = kubectlPass ? "kubectl" : "ssh";
          const inner = child("command_pass", pass);
          const innerCommand = inner?.args[0];
          // kubectl_pass may name the pod with `pod_name <target>` instead of the last argument of the line.
          const podName = kubectlPass ? child("pod_name", pass)?.args[0] : undefined;
          if (kubectlPass && child("pod_name", pass) && (typeof podName !== "string" || podName === "")) {
            throw new Error(`route ${name}: pod_name debe ser un nombre, no "${podName}"`);
          }
          const podMatchDirective = kubectlPass ? child("pod_match", pass) : undefined;
          const podMatch = podMatchDirective?.args[0];
          if (podMatchDirective && (typeof podMatch !== "string" || podMatch === "")) {
            throw new Error(`route ${name}: pod_match debe ser un patrón, no "${podMatch}"`);
          }
          if (podMatchDirective && podName !== undefined) {
            throw new Error(`route ${name}: pod_name y pod_match no se pueden combinar`);
          }
          if (pass.args.length < 1 && podName === undefined && podMatch === undefined) {
            throw new Error(`route ${name}: ${directive} requiere el destino (${kubectlPass ? "pod o tipo/nombre, o las subdirectivas pod_name / pod_match" : "usuario@host"})`);
          }
          if (!inner || (innerCommand !== "curl" && innerCommand !== "wget" && innerCommand !== "node")) {
            throw new Error(`route ${name}: ${directive} requiere un command_pass hijo con "curl", "wget" o "node"${innerCommand === undefined ? "" : `, no "${innerCommand}"`}`);
          }
          const innerConcurrency = child("concurrency", inner)?.args[0];
          if (innerConcurrency !== undefined && !(typeof innerConcurrency === "number" && Number.isInteger(innerConcurrency) && innerConcurrency >= 1)) {
            throw new Error(`route ${name}: concurrency debe ser un entero positivo, no "${innerConcurrency}"`);
          }
          // ssh_pass takes the host first (an alias of ~/.ssh/config works); the arguments after it are
          // ssh options. The older "options… destination" form still works when the first one is an option.
          const sshArgs = (() => {
            if (kubectlPass) return undefined;
            const { options, password } = sshPassOptions(name, pass);
            const args = pass.args.map(String);
            const legacy = args[0]!.startsWith("-");
            const host = legacy ? args.at(-1)! : args[0]!;
            const given = legacy ? args.slice(0, -1) : args.slice(1);
            return { args: [...given, ...options, host], password };
          })();
          return {
            method,
            pattern,
            action: {
              kind: "command_pass",
              command,
              engine: innerCommand,
              concurrency: Number(innerConcurrency ?? 1),
              // The options of the line, the context / namespace selectors (kubectl), then the target (always last).
              ...(typeof podMatch === "string" ? { podMatch: { glob: podMatch, selectors: selectorArgs(name, pass) } } : {}),
              args: sshArgs?.args ?? (typeof podMatch === "string"
                ? [...pass.args.map(String), ...selectorArgs(name, pass)]
                : podName === undefined
                ? [...pass.args.slice(0, -1).map(String), ...selectorArgs(name, pass), String(pass.args.at(-1))]
                : [...pass.args.map(String), ...selectorArgs(name, pass), String(podName)]),
              engineArgs: [...inner.args.slice(1).map(String), ...optionArgs(name, innerCommand, inner)],
              ...(sshArgs?.password === undefined ? {} : { password: sshArgs.password }),
            },
          };
        }
        if (commandPass && !["curl", "node", "ssh", "kubectl"].includes(String(commandPass.args[0]))) {
          throw new Error(`route ${name}: command_pass solo soporta "curl", "node", "ssh" y "kubectl", no "${commandPass.args[0]}"`);
        }
        const concurrencyValue = commandPass && child("concurrency", commandPass)?.args[0];
        if (
          concurrencyValue !== undefined &&
          !(typeof concurrencyValue === "number" && Number.isInteger(concurrencyValue) && concurrencyValue >= 1)
        ) {
          throw new Error(`route ${name}: concurrency debe ser un entero positivo, no "${concurrencyValue}"`);
        }
        const engine = commandPass && child("engine", commandPass)?.args[0];
        const remote = commandPass?.args[0] === "ssh" || commandPass?.args[0] === "kubectl";
        if (engine !== undefined && !remote) {
          throw new Error(`route ${name}: engine solo aplica a command_pass ssh y kubectl`);
        }
        if (engine !== undefined && engine !== "curl" && engine !== "node" && engine !== "wget") {
          throw new Error(`route ${name}: engine solo soporta "curl", "node" y "wget", no "${engine}"`);
        }
        if (remote && commandPass!.args.length < 2) {
          throw new Error(
            `route ${name}: command_pass ${commandPass!.args[0]} requiere el destino (${commandPass!.args[0] === "ssh" ? "usuario@host" : "pod o tipo/nombre"})`,
          );
        }
        return {
          method,
          pattern,
          action: respond
            ? { kind: "respond", status: Number(respond.args[0]), body: String(respond.args[1] ?? "") }
            : proxyPass
              ? { kind: "proxy_pass", target: new URL(String(proxyPass.args[0])) }
              : { kind: "command_pass", command: commandPass!.args[0] as Command, engine: (engine as Engine | undefined) ?? "curl", concurrency: Number(concurrencyValue ?? 1), args: commandPassArgs(name, commandPass!) },
        };
      }),
  };
};

/** Full URL of a request, including requests tunnelled through CONNECT. */
const requestUrl = (req: http.IncomingMessage, tunnels: Map<number, string | undefined>) => {
  if (/^https?:\/\//.test(req.url ?? "")) return req.url!;
  const tunnel = tunnels.get(req.socket.remotePort!);
  if (tunnel) return `https://${tunnel}${req.url}`;
  return `http://${req.headers.host}${req.url}`;
};

const hopByHop = new Set([
  "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer",
  "host", "content-length",
]);

interface Reply {
  /** Command line executed to produce this reply (`command_pass` only). */
  command?: string[];
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

/**
 * Forwards the request to `target`. The original path and query are kept,
 * unless `target` declares its own path, which then replaces the path.
 */
const forward = async (
  req: http.IncomingMessage,
  body: Buffer,
  url: string,
  target: URL,
  logger: RequestTransaction,
): Promise<Reply> => {
  const original = new URL(url);
  const upstream = new URL(target);
  if (upstream.pathname === "/") upstream.pathname = original.pathname;
  upstream.search = original.search;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (!hopByHop.has(k) && v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const proxyPass = logger.proxyPass.openTransaction({
    method: req.method ?? "GET",
    target: upstream.toString(),
    headers: Object.fromEntries(headers),
    body: hasBody ? body : Buffer.alloc(0),
  });
  const reply = await fetchUpstream(upstream, req.method, headers, hasBody ? body : undefined);
  proxyPass.end(reply);
  return reply;
};

const fetchUpstream = async (upstream: URL, method: string | undefined, headers: Headers, body: Buffer | undefined): Promise<Reply> => {
  try {
    const response = await fetch(upstream, { method, headers, body, redirect: "manual" });
    // fetch has already decoded the body, so encoding/length no longer apply.
    return {
      status: response.status,
      headers: Object.fromEntries(
        [...response.headers].filter(([k]) => !hopByHop.has(k) && k !== "content-encoding"),
      ),
      body: Buffer.from(await response.arrayBuffer()),
    };
  } catch (error) {
    return {
      status: 502,
      headers: { "content-type": "text/plain" },
      body: Buffer.from(`bad gateway: ${(error as Error).message}`),
    };
  }
};

/** Passes the request to an external command, which performs it against the original URL. */
const commandPass = async (
  req: http.IncomingMessage,
  body: Buffer,
  url: string,
  command: Command,
  engine: Engine | undefined,
  args: string[],
  engineArgs: string[] | undefined,
  podMatch: { glob: string; selectors: string[] } | undefined,
  password: string | undefined,
  logger: RequestTransaction,
): Promise<Reply> => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    // curl negotiates the encoding itself (`--compressed`).
    if (!hopByHop.has(k) && k !== "accept-encoding" && v !== undefined) {
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
  }
  let executed: string[] | undefined;
  let script: string | undefined;
  // One transaction per process: kubectl runs the engine after `--`, so it opens two (the engine is
  // the child of kubectl). The exit code of kubectl is the one of the engine (`kubectl exec` forwards it).
  const processes: CommandTransaction[] = [];
  const onCommand = (c: string[]) => {
    executed = c;
    const open = (parent: { command: RequestTransaction["command"] }, line: string[]) => {
      const process = parent.command.openTransaction({ program: line[0]!, args: line.slice(1) });
      processes.push(process);
      return process;
    };
    const outer = open(logger, c);
    const remote = command === "kubectl" ? c.indexOf("--") : -1;
    const inner = remote >= 0 ? open(outer, c.slice(remote + 1)) : outer;
    // `node` reads its script from stdin: the command alone does not say what it runs.
    if (script !== undefined) inner.script.openTransaction({ script, program: "node" });
  };
  // The `kubectl get pods` of `pod_match` is a process of its own, a sibling of the `kubectl exec`.
  const lookupLog: ConsoleEntry[] = [];
  let lookup: CommandTransaction | undefined;
  const onLookup = {
    onCommand: (c: string[]) => {
      lookup = logger.command.openTransaction({ program: c[0]!, args: c.slice(1) });
    },
    onConsole: (entry: ConsoleEntry) => {
      lookupLog.push(entry);
    },
    onExit: (code: number | null) => lookup?.end(code, lookupLog),
  };
  const onScript = (s: string) => {
    script = s;
  };
  // Goes only to the log (the response to the client is untouched).
  const consoleLog: ConsoleEntry[] = [];
  const onConsole = (entry: ConsoleEntry) => {
    consoleLog.push(entry);
  };
  const onExit = (code: number | null) => {
    // Every process that ran ends with an exit code and a `console_log` (empty when it wrote nothing);
    // the innermost ends first.
    for (const process of [...processes].reverse()) process.end(code, consoleLog);
  };
  try {
    const request = { method: req.method ?? "GET", url, headers, body, args, engineArgs, podMatch, onLookup, password, onCommand, onScript, onExit, onConsole };
    const response = await (command === "ssh"
      ? sshRequest(request, engine ?? "curl")
      : command === "kubectl"
        ? kubectlRequest(request, engine ?? "curl")
        : command === "node"
          ? nodeRequest(request)
          : curl(request));
    return {
      ...response,
      command: executed,
      headers: Object.fromEntries(
        Object.entries(response.headers).filter(([k]) => !hopByHop.has(k) && k !== "content-encoding"),
      ),
    };
  } catch (error) {
    return { ...text(502, `bad gateway: ${(error as Error).message}`), command: executed };
  }
};

const text = (status: number, body: string): Reply => ({
  status,
  headers: { "content-type": "text/plain" },
  body: Buffer.from(body),
});

/**
 * Proxy that answers every request with `ok`.
 * - HTTP: absolute-URI requests are answered directly.
 * - HTTPS: CONNECT tunnels are terminated locally with the configured
 *   certificate and then answered directly.
 */
export const createProxyServers = ({
  ssl,
  listeners,
  routes,
  logFile,
}: Pick<ProxyConfig, "ssl" | "routes"> & { listeners: ListenerConfig[]; logFile?: string }) => {
  ensureCerts(ssl);
  for (const { https } of listeners) if (https) ensureCerts(https);
  const tlsOptions = { key: readFileSync(ssl.key), cert: readFileSync(ssl.cert) };
  if (logFile) mkdirSync(dirname(logFile), { recursive: true });

  // The logger writes `.ndjson` lines to this stream; without `log_file` they are dropped.
  const Logger = createLogger_experimental(
    new WritableStream<Uint8Array>({ write: (chunk) => void (logFile && appendFileSync(logFile, chunk)) }),
  );

  // One semaphore per command_pass route: `concurrency` processes at a time, the rest queue up.
  const limits = new Map<Route, Semaphore>();
  const limitOf = (route: Route, concurrency: number) => {
    if (!limits.has(route)) limits.set(route, new Semaphore(concurrency));
    return limits.get(route)!;
  };

  const answer = async (route: Route | undefined, req: http.IncomingMessage, body: Buffer, url: string, logger: RequestTransaction) => {
    const action = route?.action;
    if (!route || !action) return text(200, "ok");
    switch (action.kind) {
      case "respond":
        return text(action.status, action.body);
      case "proxy_pass":
        return forward(req, body, url, action.target, logger);
      case "command_pass": {
        const release = await limitOf(route, action.concurrency).acquire();
        try {
          return await commandPass(req, body, url, action.command, action.engine, action.args, action.engineArgs, action.podMatch, action.password, logger);
        } finally {
          release();
        }
      }
    }
  };

  // Client port of each loopback connection -> host of the CONNECT that opened it.
  const tunnels = new Map<number, string | undefined>();

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = requestUrl(req, tunnels);
    const body = Buffer.concat(await Array.fromAsync(req));
    const logger = Logger.request.openTransaction({
      method: req.method ?? "GET",
      url,
      httpVersion: req.httpVersion,
      headers: req.headers,
      body,
    });

    const route = routes.find(
      (r) => (r.method === null || r.method === req.method) && r.pattern.test(url),
    );
    const reply = await answer(route, req, body, url, logger);

    logger.response(reply);
    res.writeHead(reply.status, reply.headers);
    res.end(reply.body);
  };
  // CONNECT tunnels are piped into this loopback HTTPS server instead of wrapping the socket in a
  // `tls.TLSSocket`: Bun 1.3.x never completes the handshake on a wrapped socket.
  const tlsServer = https.createServer(tlsOptions, handle);
  tlsServer.on("tlsClientError", () => {});
  tlsServer.listen(0, "127.0.0.1");
  tlsServer.unref();
  let open = listeners.length;

  const onConnect = (req: http.IncomingMessage, socket: Duplex) => {
    socket.on("error", () => {});
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    let port: number | undefined;
    const inner = net.connect((tlsServer.address() as AddressInfo).port, "127.0.0.1", () => {
      port = inner.localPort!;
      tunnels.set(port, req.url?.replace(/:443$/, ""));
    });
    inner.on("error", () => socket.destroy());
    inner.on("close", () => {
      if (port) tunnels.delete(port);
      socket.destroy();
    });
    socket.on("close", () => inner.destroy());
    socket.pipe(inner).pipe(socket);
  };

  // `listen socks4|socks5`: the client speaks SOCKS and, once the handshake is done, its bytes are piped
  // into a loopback server, the same way as a CONNECT tunnel: TLS (first byte 0x16) goes to the TLS
  // server and anything else to a plain HTTP one, so the routes apply to the decrypted requests.
  const plainServer = http.createServer(handle);
  if (listeners.some((l) => l.socks)) {
    plainServer.listen(0, "127.0.0.1");
    plainServer.unref();
  }
  const onSocks = (socket: net.Socket, socks: 4 | 5) => {
    socket.on("error", () => {});
    void (async () => {
      const { target, rest } = await socksHandshake(socket, socks);
      const first =
        rest.length > 0
          ? rest
          : await new Promise<Buffer>((resolve) => {
              socket.once("data", (chunk: Buffer) => {
                socket.pause();
                resolve(chunk);
              });
              socket.once("close", () => resolve(Buffer.alloc(0)));
              socket.resume();
            });
      if (first.length === 0 || socket.destroyed) return socket.destroy();
      const encrypted = first[0] === 0x16;
      const loopback = (encrypted ? (tlsServer.address() as AddressInfo) : (plainServer.address() as AddressInfo)).port;
      let port: number | undefined;
      const inner = net.connect(loopback, "127.0.0.1", () => {
        port = inner.localPort!;
        if (encrypted) tunnels.set(port, targetName(target));
        inner.write(first);
        socket.pipe(inner).pipe(socket);
      });
      inner.on("error", () => socket.destroy());
      inner.on("close", () => {
        if (port) tunnels.delete(port);
        socket.destroy();
      });
      socket.on("close", () => inner.destroy());
    })().catch(() => socket.destroy());
  };

  return listeners.map(({ https: https_, socks }): net.Server => {
    const onClose = () => {
      if (--open === 0) {
        tlsServer.close();
        plainServer.close();
      }
    };
    const onListening = (server: net.Server) => () => {
      // `port 0` is assigned by the system: log the real one.
      const { address, port } = server.address() as AddressInfo;
      Logger.listening(address, port);
    };
    if (socks) {
      const server = net.createServer((socket) => onSocks(socket, socks));
      server.on("close", onClose);
      server.on("listening", onListening(server));
      return server;
    }
    // With `listen https` the proxy itself speaks TLS (`curl --proxy https://...`).
    const server: http.Server = https_
      ? https.createServer({ key: readFileSync(https_.key), cert: readFileSync(https_.cert) }, handle)
      : http.createServer(handle);
    if (https_) server.on("tlsClientError", () => {});
    server.on("close", onClose);
    server.on("connect", onConnect);
    server.on("listening", onListening(server));
    return server;
  });
};

/** The first server of {@link createProxyServers}: enough when the manifest has a single `listen`. */
export const createProxyServer = (config: Pick<ProxyConfig, "ssl" | "routes"> & { logFile?: string } & ({ listeners: ListenerConfig[] } | { https?: ProxyConfig["https"] })) =>
  createProxyServers({ ...config, listeners: "listeners" in config ? config.listeners : [{ host: "127.0.0.1", port: 0, https: config.https }] })[0]!;
