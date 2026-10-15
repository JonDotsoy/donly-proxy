import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
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

type Command = "curl" | "node" | "ssh" | "kubectl";

export interface Route {
  /** `null` matches any method. */
  method: string | null;
  /** Tested against the full request URL, e.g. `https://example.com/path`. */
  pattern: RegExp;
  action:
    | { kind: "respond"; status: number; body: string }
    | { kind: "proxy_pass"; target: URL }
    | { kind: "command_pass"; command: Command; engine?: Engine; concurrency: number; args: string[]; engineArgs?: string[]; password?: string };
}

export interface ProxyConfig {
  host: string;
  port: number;
  ssl: { cert: string; key: string };
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

/** `context <name>` and `namespace <name>` inside a `kubectl_pass` / `command_pass kubectl`: they become `--context` / `--namespace`. */
const selectorArgs = (name: string, directive: Directive, command = "kubectl"): string[] =>
  (["context", "namespace"] as const).flatMap((selector) => {
    const child = directive.children.find((c) => c.name === selector);
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
  const logFile = child("log_file")?.args[0];
  if (logFile !== undefined && !String(logFile).endsWith(".ndjson")) {
    throw new Error(`log_file ${logFile}: solo se soporta la extensión .ndjson`);
  }

  return {
    host: String(child("host")?.args[0] ?? "127.0.0.1"),
    port: Number(child("port")?.args[0] ?? 0),
    ssl: {
      cert: resolve(String(child("cert", ssl)?.args[0] ?? "./certs/cert.pem")),
      key: resolve(String(child("key", ssl)?.args[0] ?? "./certs/key.pem")),
    },
    logFile: logFile === undefined ? undefined : resolve(String(logFile)),
    routes: (proxy?.children ?? [])
      // A route without a body (`route {}`) is a no-op: it is skipped and never shadows later routes.
      .filter((c) => c.name === "route" && c.children.length > 0)
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
          if (pass.args.length < 1) {
            throw new Error(`route ${name}: ${directive} requiere el destino (${kubectlPass ? "pod o tipo/nombre" : "usuario@host"})`);
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
              args: sshArgs?.args ?? [...pass.args.slice(0, -1).map(String), ...selectorArgs(name, pass), String(pass.args.at(-1))],
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
  try {
    const response = await fetch(upstream, {
      method: req.method,
      headers,
      body: hasBody ? body : undefined,
      redirect: "manual",
    });
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
  password: string | undefined,
  emit: (entry: Record<string, unknown>) => void,
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
  // kubectl runs the engine after `--`: both programs are logged, and the exit code of kubectl
  // is the one of the engine (`kubectl exec` forwards it).
  const onCommand = (c: string[]) => {
    executed = c;
    emit({ type: "command", program: c[0], command: c });
    const remote = command === "kubectl" ? c.indexOf("--") : -1;
    if (remote >= 0) emit({ type: "command", program: c[remote + 1], command: c.slice(remote + 1) });
    // `node` reads its script from stdin: the command alone does not say what it runs.
    if (script !== undefined) emit({ type: "script", program: "node", script });
  };
  const onScript = (s: string) => {
    script = s;
  };
  const onExit = (code: number | null) => {
    if (command === "kubectl") emit({ type: "command_exit", program: executed?.[executed.indexOf("--") + 1], exit_code: code });
    emit({ type: "command_exit", program: executed?.[0], exit_code: code });
  };
  try {
    const request = { method: req.method ?? "GET", url, headers, body, args, engineArgs, password, onCommand, onScript, onExit };
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

/** Payload as utf8 when lossless, base64 otherwise. */
const encodePayload = (body: Buffer) => {
  const utf8 = body.toString("utf8");
  return Buffer.from(utf8).equals(body)
    ? { payload: utf8 }
    : { payload: body.toString("base64"), payload_encoding: "base64" };
};

/**
 * Proxy that answers every request with `ok`.
 * - HTTP: absolute-URI requests are answered directly.
 * - HTTPS: CONNECT tunnels are terminated locally with the configured
 *   certificate and then answered directly.
 */
export const createProxyServer = ({
  ssl,
  routes,
  logFile,
}: Pick<ProxyConfig, "ssl" | "routes"> & { logFile?: string }) => {
  ensureCerts(ssl);
  const tlsOptions = { key: readFileSync(ssl.key), cert: readFileSync(ssl.cert) };
  if (logFile) mkdirSync(dirname(logFile), { recursive: true });

  const log = (entry: Record<string, unknown>) => {
    // `timestamp` is the wall clock (ms); `performance_timestamp` is the exact moment from the Performance API.
    if (logFile) appendFileSync(logFile, JSON.stringify({ timestamp: new Date().toISOString(), performance_timestamp: performance.timeOrigin + performance.now(), ...entry }) + "\n");
  };

  // One semaphore per command_pass route: `concurrency` processes at a time, the rest queue up.
  const limits = new Map<Route, Semaphore>();
  const limitOf = (route: Route, concurrency: number) => {
    if (!limits.has(route)) limits.set(route, new Semaphore(concurrency));
    return limits.get(route)!;
  };

  const answer = async (route: Route | undefined, req: http.IncomingMessage, body: Buffer, url: string, emit: (entry: Record<string, unknown>) => void) => {
    const action = route?.action;
    if (!route || !action) return text(200, "ok");
    switch (action.kind) {
      case "respond":
        return text(action.status, action.body);
      case "proxy_pass":
        return forward(req, body, url, action.target);
      case "command_pass": {
        const release = await limitOf(route, action.concurrency).acquire();
        try {
          return await commandPass(req, body, url, action.command, action.engine, action.args, action.engineArgs, action.password, emit);
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
    const transaction = {
      transaction_id: randomUUID(),
      http_version: `HTTP/${req.httpVersion}`,
      method: req.method,
      url,
    };
    log({ ...transaction, type: "request", headers: req.headers, ...encodePayload(body) });

    const route = routes.find(
      (r) => (r.method === null || r.method === req.method) && r.pattern.test(url),
    );
    const reply = await answer(route, req, body, url, (entry) => log({ ...transaction, ...entry }));

    log({
      ...transaction,
      type: "response",
      status: reply.status,
      ...(reply.command && { command: reply.command }),
      headers: reply.headers,
      ...encodePayload(reply.body),
    });
    res.writeHead(reply.status, reply.headers);
    res.end(reply.body);
  };
  const server = http.createServer(handle);

  // CONNECT tunnels are piped into this loopback HTTPS server instead of wrapping the socket in a
  // `tls.TLSSocket`: Bun 1.3.x never completes the handshake on a wrapped socket.
  const tlsServer = https.createServer(tlsOptions, handle);
  tlsServer.on("tlsClientError", () => {});
  tlsServer.listen(0, "127.0.0.1");
  tlsServer.unref();
  server.on("close", () => tlsServer.close());

  server.on("connect", (req, socket: Duplex) => {
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
  });

  server.on("listening", () => {
    // `port 0` is assigned by the system: log the real one.
    const { address, port } = server.address() as AddressInfo;
    log({ type: "listening", host: address, port });
  });

  return server;
};
