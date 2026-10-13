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
  status: number;
  body: string;
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
        const respond = child("respond", route);
        if (!respond) throw new Error(`route ${route.args.join(" ")}: falta \`respond\``);
        return {
          method: route.args.length > 1 ? String(route.args[0]).toUpperCase() : null,
          pattern: new RegExp(String(route.args[route.args.length - 1])),
          status: Number(respond.args[0]),
          body: String(respond.args[1] ?? ""),
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
    res.writeHead(route?.status ?? 200, { "content-type": "text/plain" });
    res.end(route?.body ?? "ok");
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
