import http from "node:http";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { readFileSync } from "node:fs";

const tlsOptions = {
  key: readFileSync(new URL("../certs/key.pem", import.meta.url)),
  cert: readFileSync(new URL("../certs/cert.pem", import.meta.url)),
};

const respond: http.RequestListener = (_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
};

/**
 * Proxy that answers every request with `ok`.
 * - HTTP: absolute-URI requests are answered directly.
 * - HTTPS: CONNECT tunnels are terminated locally with a self-signed
 *   certificate and then answered directly.
 */
export const createProxyServer = () => {
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
  const port = Number(process.env.PORT ?? 8080);
  createProxyServer().listen(port, () => {
    console.log(`proxy listening on :${port}`);
  });
}
