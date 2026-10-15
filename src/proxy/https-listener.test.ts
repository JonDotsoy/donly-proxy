import { afterAll, beforeAll, expect } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-https-listener-"));
const manifest = join(dir, "manifest.donly");

// Route targets are filled in once the upstream's dynamic port is known.
const upstream = http.createServer((_req, res) => res.end("from upstream"));

const manifestPayload = (port: number) => `proxy {
  listen https 127.0.0.1 0 {
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
  }
  route https://example.com/ {
    respond 200 "secure good"
  }
  route http://example.com/ {
    respond 200 "plain good"
  }
  route http://upstream.test/ {
    proxy_pass http://127.0.0.1:${port}/
  }
}
`;

let server: http.Server;
let proxyPort: number;
let savedNoProxy: [string | undefined, string | undefined];

beforeAll(async () => {
  savedNoProxy = [process.env.NO_PROXY, process.env.no_proxy];
  for (const name of ["NO_PROXY", "no_proxy"]) process.env[name] = "";
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const payload = manifestPayload((upstream.address() as AddressInfo).port);
  writeFileSync(manifest, payload);
  server = createProxyServer(await loadConfig(manifest));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxyPort = (server.address() as AddressInfo).port;
});

afterAll(() => {
  [process.env.NO_PROXY, process.env.no_proxy] = savedNoProxy;
  server.close();
  upstream.close();
});

const curl = async (...args: string[]) => {
  const proc = Bun.spawn(["curl", "-sS", "-k", "--proxy-insecure", "--max-time", "4", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { out, err, code: await proc.exited };
};

testFeature(manifestPayload(0), ["/proxy/listen", "/proxy/route/respond"], "should accept an http request through an https proxy", async () => {
  const res = await curl("--proxy", `https://127.0.0.1:${proxyPort}`, "http://example.com/");
  expect(res.out).toBe("plain good");
});

testFeature(manifestPayload(0), ["/proxy/listen", "/proxy/route/respond"], "should tunnel an https request through an https proxy", async () => {
  const res = await curl("--proxy", `https://127.0.0.1:${proxyPort}`, "https://example.com/");
  expect(res.out).toBe("secure good");
});

testFeature(manifestPayload(0), ["/proxy/listen", "/proxy/route/proxy_pass"], "should proxy_pass through an https proxy", async () => {
  const res = await curl("--proxy", `https://127.0.0.1:${proxyPort}`, "http://upstream.test/");
  expect(res.out).toBe("from upstream");
});

testFeature(manifestPayload(0), ["/proxy/listen"], "should refuse a plain http connection to an https proxy", async () => {
  const res = await curl("--proxy", `http://127.0.0.1:${proxyPort}`, "http://example.com/");
  expect(res.out).not.toBe("plain good");
});

const parse = async (name: string, body: string) => {
  const file = join(dir, `${name}.donly`);
  writeFileSync(file, `proxy {\n${body}\n}\n`);
  return loadConfig(file);
};

const syntaxes: { title: string; body: string; paths: string[]; host: string; port: number; https: boolean; certs?: [string, string] }[] = [
  { title: "listen 0", body: "  listen 0", paths: ["/proxy/listen"], host: "127.0.0.1", port: 0, https: false },
  { title: "listen 8080", body: "  listen 8080", paths: ["/proxy/listen"], host: "127.0.0.1", port: 8080, https: false },
  { title: "listen http 0", body: "  listen http 0", paths: ["/proxy/listen"], host: "127.0.0.1", port: 0, https: false },
  { title: "listen https 0 (self-signed)", body: "  listen https 0", paths: ["/proxy/listen"], host: "127.0.0.1", port: 0, https: true, certs: ["certs/cert.pem", "certs/key.pem"] },
  { title: "listen http 127.0.0.1 0", body: "  listen http 127.0.0.1 0", paths: ["/proxy/listen"], host: "127.0.0.1", port: 0, https: false },
  { title: "listen http ::1 0", body: "  listen http ::1 0", paths: ["/proxy/listen"], host: "::1", port: 0, https: false },
  { title: "listen https 127.0.0.1 0", body: "  listen https 127.0.0.1 0", paths: ["/proxy/listen"], host: "127.0.0.1", port: 0, https: true, certs: ["certs/cert.pem", "certs/key.pem"] },
  {
    title: "listen https 127.0.0.1 0 with ssl",
    body: '  listen https 127.0.0.1 0 {\n    ssl {\n      cert "./my/c.pem"\n      key "./my/k.pem"\n    }\n  }',
    paths: ["/proxy/listen", "/proxy/listen/ssl"],
    host: "127.0.0.1",
    port: 0,
    https: true,
    certs: ["my/c.pem", "my/k.pem"],
  },
  { title: "listen https 0 with ssl", body: '  listen https 0 {\n    ssl {\n      cert "./my/c.pem"\n      key "./my/k.pem"\n    }\n  }', paths: ["/proxy/listen", "/proxy/listen/ssl"], host: "127.0.0.1", port: 0, https: true, certs: ["my/c.pem", "my/k.pem"] },
  { title: "port 8080 (alias of listen http)", body: "  port 8080", paths: ["/proxy/port"], host: "127.0.0.1", port: 8080, https: false },
  { title: "port 0 (alias of listen http)", body: "  port 0", paths: ["/proxy/port"], host: "127.0.0.1", port: 0, https: false },
  { title: "port http 0", body: "  port http 0", paths: ["/proxy/port"], host: "127.0.0.1", port: 0, https: false },
  { title: "port https 0 with ssl", body: '  port https 0 {\n    ssl {\n      cert "./my/c.pem"\n      key "./my/k.pem"\n    }\n  }', paths: ["/proxy/port", "/proxy/port/ssl"], host: "127.0.0.1", port: 0, https: true, certs: ["my/c.pem", "my/k.pem"] },
  { title: "host directive + port keeps the host", body: '  host "::1"\n  port 0', paths: ["/proxy/host", "/proxy/port"], host: "::1", port: 0, https: false },
  { title: "listen host overrides the host directive", body: '  host "::1"\n  listen http 127.0.0.1 0', paths: ["/proxy/host", "/proxy/listen"], host: "127.0.0.1", port: 0, https: false },
];

for (const [i, syntax] of syntaxes.entries()) {
  testFeature(`proxy {\n${syntax.body}\n}\n`, syntax.paths, `should parse the syntax: ${syntax.title}`, async (payload) => {
    const config = await parse(`syntax-${i}`, payload.replace(/^proxy \{\n|\n\}\n$/g, ""));
    expect(config.host).toBe(syntax.host);
    expect(config.port).toBe(syntax.port);
    expect(config.https !== undefined).toBe(syntax.https);
    if (syntax.certs) {
      expect(config.https?.cert).toBe(join(dir, syntax.certs[0]));
      expect(config.https?.key).toBe(join(dir, syntax.certs[1]));
    }
  });
}

testFeature(`proxy {\n  listen 0\n  port 0\n}\n`, ["/proxy/listen", "/proxy/port"], "should reject listen and port declared together", async (payload) => {
  const bad = join(dir, "both.donly");
  writeFileSync(bad, payload);
  expect(loadConfig(bad)).rejects.toThrow("listen y port no se pueden declarar a la vez");
});

testFeature(`proxy {\n  listen https 127.0.0.1\n}\n`, ["/proxy/listen"], "should reject a listen without a numeric port", async (payload) => {
  const bad = join(dir, "no-port.donly");
  writeFileSync(bad, payload);
  expect(loadConfig(bad)).rejects.toThrow('listen: el puerto debe ser un número, no "127.0.0.1"');
});

testFeature(`proxy {\n  listen http a b 0\n}\n`, ["/proxy/listen"], "should reject a listen with too many arguments", async (payload) => {
  const bad = join(dir, "too-many.donly");
  writeFileSync(bad, payload);
  expect(loadConfig(bad)).rejects.toThrow("listen: se esperaba [http|https] [host] puerto");
});

const selfSigned = join(dir, "selfsigned.donly");
testFeature(`proxy {\n  listen https 127.0.0.1 0\n}\n`, ["/proxy/listen"], "should serve https with a self-signed certificate generated next to the manifest", async (payload) => {
  writeFileSync(selfSigned, payload);
  const s = createProxyServer(await loadConfig(selfSigned));
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  try {
    const res = await curl("--proxy", `https://127.0.0.1:${(s.address() as AddressInfo).port}`, "http://example.com/");
    expect(res.code).toBe(0);
    expect(existsSync(join(dir, "certs/cert.pem"))).toBe(true);
  } finally {
    s.close();
  }
});
