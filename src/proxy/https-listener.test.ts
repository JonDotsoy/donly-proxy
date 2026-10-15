import { afterAll, beforeAll, expect } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-https-listener-"));
const manifest = join(dir, "manifest.donly");

// Route targets are filled in once the upstream's dynamic port is known.
const upstream = http.createServer((_req, res) => res.end("from upstream"));

const manifestPayload = (port: number) => `proxy {
  host "127.0.0.1"
  port 0
  ssl {
    cert "./certs/cert.pem"
    key "./certs/key.pem"
    listen true
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

testFeature(manifestPayload(0), ["/proxy/ssl/listen", "/proxy/route/respond"], "should accept an http request through an https proxy", async () => {
  const res = await curl("--proxy", `https://127.0.0.1:${proxyPort}`, "http://example.com/");
  expect(res.out).toBe("plain good");
});

testFeature(manifestPayload(0), ["/proxy/ssl/listen", "/proxy/route/respond"], "should tunnel an https request through an https proxy", async () => {
  const res = await curl("--proxy", `https://127.0.0.1:${proxyPort}`, "https://example.com/");
  expect(res.out).toBe("secure good");
});

testFeature(manifestPayload(0), ["/proxy/ssl/listen", "/proxy/route/proxy_pass"], "should proxy_pass through an https proxy", async () => {
  const res = await curl("--proxy", `https://127.0.0.1:${proxyPort}`, "http://upstream.test/");
  expect(res.out).toBe("from upstream");
});

testFeature(manifestPayload(0), ["/proxy/ssl/listen"], "should refuse a plain http connection to an https proxy", async () => {
  const res = await curl("--proxy", `http://127.0.0.1:${proxyPort}`, "http://example.com/");
  expect(res.out).not.toBe("plain good");
});

testFeature(`proxy {\n  ssl {\n    listen "yes"\n  }\n}\n`, ["/proxy/ssl/listen"], "should reject a non-boolean ssl.listen", async (payload) => {
  const bad = join(dir, "bad.donly");
  writeFileSync(bad, payload);
  expect(loadConfig(bad)).rejects.toThrow('ssl.listen debe ser true o false, no "yes"');
});
