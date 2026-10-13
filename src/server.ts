import http from "node:http";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DON } from "donly";
import { ensureCerts } from "./certs";

export interface Route {
  /** `null` matches any method. */
  method: string | null;
  /** Tested against the full request URL, e.g. `https://example.com/path`. */
  pattern: RegExp;
  action:
    | { kind: "respond"; status: number; body: string }
    | { kind: "proxy_pass"; target: URL };
}

export interface ProxyConfig {
  host: string;
  port: number;
  ssl: { cert: string; key: string };
  routes: Route[];
  /** Absolute path of the `.ndjson` transaction log, if configured. */
  logFile?: string;
}

const defaultManifest = new URL("../manifest.donly", import.meta.url);

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
    port: Number(child("port")?.args[0] ?? 8080),
    ssl: {
      cert: resolve(String(child("cert", ssl)?.args[0] ?? "./certs/cert.pem")),
      key: resolve(String(child("key", ssl)?.args[0] ?? "./certs/key.pem")),
    },
    logFile: logFile === undefined ? undefined : resolve(String(logFile)),
    routes: (proxy?.children ?? [])
      .filter((c) => c.name === "route")
      .map((route): Route => {
        const name = route.args.join(" ");
        const respond = child("respond", route);
        const proxyPass = child("proxy_pass", route);
        if (!respond === !proxyPass) {
          throw new Error(`route ${name}: se requiere exactamente uno de \`respond\` o \`proxy_pass\``);
        }
        return {
          method: route.args.length > 1 ? String(route.args[0]).toUpperCase() : null,
          pattern: new RegExp(String(route.args[route.args.length - 1])),
          action: respond
            ? { kind: "respond", status: Number(respond.args[0]), body: String(respond.args[1] ?? "") }
            : { kind: "proxy_pass", target: new URL(String(proxyPass!.args[0])) },
        };
      }),
  };
};

/** Full URL of a request, including requests tunnelled through CONNECT. */
const requestUrl = (req: http.IncomingMessage) => {
  if (/^https?:\/\//.test(req.url ?? "")) return req.url!;
  const tunnel = (req.socket as TunnelSocket).tunnelHost;
  if (tunnel) return `https://${tunnel}${req.url}`;
  return `http://${req.headers.host}${req.url}`;
};

const hopByHop = new Set([
  "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer",
  "host", "content-length",
]);

interface Reply {
  status: number;
  headers: Record<string, string>;
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

type TunnelSocket = tls.TLSSocket & { tunnelHost?: string };

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
    if (logFile) appendFileSync(logFile, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n");
  };

  const server = http.createServer(async (req, res) => {
    const url = requestUrl(req);
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
    const reply =
      route?.action.kind === "proxy_pass"
        ? await forward(req, body, url, route.action.target)
        : route?.action.kind === "respond"
          ? text(route.action.status, route.action.body)
          : text(200, "ok");

    log({ ...transaction, type: "response", status: reply.status, headers: reply.headers, ...encodePayload(reply.body) });
    res.writeHead(reply.status, reply.headers);
    res.end(reply.body);
  });

  server.on("connect", (req, socket: Duplex) => {
    socket.on("error", () => {});
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const secure: TunnelSocket = new tls.TLSSocket(socket as any, { ...tlsOptions, isServer: true });
    secure.tunnelHost = req.url?.replace(/:443$/, "");
    secure.on("error", () => {});
    server.emit("connection", secure);
  });

  return server;
};

if (import.meta.main) {
  const config = await loadConfig(process.argv[2]);
  createProxyServer(config).listen(config.port, config.host, () => {
    console.log(`proxy listening on ${config.host}:${config.port}`);
  });
}
