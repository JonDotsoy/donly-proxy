import http from "node:http";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "donly/load";

export interface ProxyConfig {
  host: string;
  port: number;
  ssl: { cert: string; key: string };
}

const defaultManifest = new URL("../manifest.donly", import.meta.url);

/** Reads the `proxy { ... }` block of a `.donly` manifest. */
export const loadConfig = async (
  manifest: string | URL = defaultManifest,
): Promise<ProxyConfig> => {
  const url = typeof manifest === "string" ? new URL(`file://${manifest}`) : manifest;
  const { proxy } = (await load(url)) as { proxy?: Record<string, any> };
  const resolve = (p: string) => fileURLToPath(new URL(p, url));
  return {
    host: proxy?.host ?? "127.0.0.1",
    port: proxy?.port ?? 8080,
    ssl: {
      cert: resolve(proxy?.ssl?.cert ?? "./certs/cert.pem"),
      key: resolve(proxy?.ssl?.key ?? "./certs/key.pem"),
    },
  };
};

const respond: http.RequestListener = (_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
};

/**
 * Proxy that answers every request with `ok`.
 * - HTTP: absolute-URI requests are answered directly.
 * - HTTPS: CONNECT tunnels are terminated locally with the configured
 *   certificate and then answered directly.
 */
export const createProxyServer = (ssl: ProxyConfig["ssl"]) => {
  const tlsOptions = { key: readFileSync(ssl.key), cert: readFileSync(ssl.cert) };
  const server = http.createServer(respond);

  server.on("connect", (_req, socket: Duplex) => {
    socket.on("error", () => {});
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const secure = new tls.TLSSocket(socket as any, { ...tlsOptions, isServer: true });
    secure.on("error", () => {});
    server.emit("connection", secure);
  });

  return server;
};

if (import.meta.main) {
  const config = await loadConfig(process.argv[2]);
  createProxyServer(config.ssl).listen(config.port, config.host, () => {
    console.log(`proxy listening on ${config.host}:${config.port}`);
  });
}
