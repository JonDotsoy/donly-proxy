import { afterAll, beforeAll, expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ensureCerts } from "../../certs";
import { createProxyServer, loadConfig } from "../../server";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-node-"));
const bin = join(dir, "bin");
const argsFile = join(dir, "node.args");
const realNode = Bun.which("node");
if (!realNode) throw new Error("node is required for these tests");

// A `node` wrapper that records its arguments and then runs the real node.
mkdirSync(bin);
writeFileSync(join(bin, "node"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nexec "${realNode}" "$@"\n`);
chmodSync(join(bin, "node"), 0o755);

const echo = async (req: http.IncomingMessage, res: http.ServerResponse) => {
  const body = Buffer.concat(await Array.fromAsync(req)).toString();
  res.setHeader("x-upstream", "yes");
  res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, custom: req.headers["x-custom"], body }));
};

const certs = { cert: join(dir, "ssl/cert.pem"), key: join(dir, "ssl/key.pem") };
ensureCerts(certs);
const httpUpstream = http.createServer(echo);
const httpsUpstream = https.createServer(
  { cert: readFileSync(certs.cert), key: readFileSync(certs.key) },
  echo,
);
const listen = (server: http.Server | https.Server) =>
  new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

const saved = { PATH: process.env.PATH, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy, TLS: process.env.NODE_TLS_REJECT_UNAUTHORIZED };
let server: http.Server;
let proxy: string;
let httpPort: number;
let httpsPort: number;

beforeAll(async () => {
  httpPort = await listen(httpUpstream);
  httpsPort = await listen(httpsUpstream);
  writeFileSync(
    join(dir, "manifest.donly"),
    `proxy {
  host "127.0.0.1"
  port 0
  ssl {
    cert "./ssl/cert.pem"
    key "./ssl/key.pem"
  }
  route http://127.0.0.1:${httpPort}/ {
    command_pass node "--no-warnings"
  }
  route https://127.0.0.1:${httpsPort}/ {
    command_pass node "--no-warnings"
  }
}
`,
  );
  // The proxied hosts are loopback addresses: fetch must not bypass the proxy for them,
  // and the self-signed upstream certificate must be accepted by the spawned node.
  process.env.NO_PROXY = process.env.no_proxy = "";
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  process.env.PATH = `${bin}${delimiter}${saved.PATH}`;

  server = createProxyServer(await loadConfig(join(dir, "manifest.donly")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  process.env.PATH = saved.PATH;
  for (const [key, value] of [["NO_PROXY", saved.NO_PROXY], ["no_proxy", saved.no_proxy], ["NODE_TLS_REJECT_UNAUTHORIZED", saved.TLS]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  server.close();
  httpUpstream.close();
  httpsUpstream.close();
});

test("[command_pass.node] command_pass node performs the request with http.request", async () => {
  const res = await fetch(`http://127.0.0.1:${httpPort}/a/b?x=1`, {
    proxy,
    method: "POST",
    body: "hello",
    headers: { "x-custom": "abc" },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("x-upstream")).toBe("yes");
  expect(await res.json()).toEqual({
    method: "POST",
    url: "/a/b?x=1",
    host: `127.0.0.1:${httpPort}`,
    custom: "abc",
    body: "hello",
  });

  // A node process was started with the manifest options followed by the request script.
  const args = readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
  expect(args[0]).toBe("--no-warnings");
  expect(args[1]).toEndWith("node-request.mjs");
});

test("[command_pass.node.https] command_pass node performs https requests with https.request", async () => {
  const res = await fetch(`https://127.0.0.1:${httpsPort}/secure?y=2`, {
    proxy,
    tls: { rejectUnauthorized: false },
  });
  expect(res.headers.get("x-upstream")).toBe("yes");
  expect(await res.json()).toMatchObject({ method: "GET", url: "/secure?y=2" });
});

test("[command_pass.node.error] command_pass node reports a bad gateway when the request fails", async () => {
  const down = http.createServer();
  const port = await listen(down);
  down.close();
  const manifest = join(dir, "down.donly");
  writeFileSync(manifest, `proxy {\n  route http://127.0.0.1:${port}/ {\n    command_pass node\n  }\n}\n`);
  const downProxy = createProxyServer(await loadConfig(manifest));
  await new Promise<void>((resolve) => downProxy.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      proxy: `http://127.0.0.1:${(downProxy.address() as AddressInfo).port}`,
    });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("node exited with 1");
  } finally {
    downProxy.close();
  }
});
