import http from "node:http";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { readFileSync } from "node:fs";
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

  return {
    host: String(child("host")?.args[0] ?? "127.0.0.1"),
    port: Number(child("port")?.args[0] ?? 8080),
    ssl: {
      cert: resolve(String(child("cert", ssl)?.args[0] ?? "./certs/cert.pem")),
      key: resolve(String(child("key", ssl)?.args[0] ?? "./certs/key.pem")),
    },
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

/**
 * Forwards the request to `target`. The original path and query are kept,
 * unless `target` declares its own path, which then replaces the path.
 */
const forward = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  target: URL,
) => {
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
      body: hasBody ? Buffer.concat(await Array.fromAsync(req)) : undefined,
      redirect: "manual",
    });
    // fetch has already decoded the body, so encoding/length no longer apply.
    const out = Object.fromEntries(
      [...response.headers].filter(([k]) => !hopByHop.has(k) && k !== "content-encoding"),
    );
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`bad gateway: ${(error as Error).message}`);
  }
};

type TunnelSocket = tls.TLSSocket & { tunnelHost?: string };

/**
 * Proxy that answers every request with `ok`.
 * - HTTP: absolute-URI requests are answered directly.
 * - HTTPS: CONNECT tunnels are terminated locally with the configured
 *   certificate and then answered directly.
 */
export const createProxyServer = ({ ssl, routes }: Pick<ProxyConfig, "ssl" | "routes">) => {
  ensureCerts(ssl);
  const tlsOptions = { key: readFileSync(ssl.key), cert: readFileSync(ssl.cert) };

  const server = http.createServer((req, res) => {
    const url = requestUrl(req);
    const route = routes.find(
      (r) => (r.method === null || r.method === req.method) && r.pattern.test(url),
    );
    if (route?.action.kind === "proxy_pass") return void forward(req, res, url, route.action.target);
    const { status, body } = route?.action.kind === "respond" ? route.action : { status: 200, body: "ok" };
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(body);
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
