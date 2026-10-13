import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "./server";

// Manifest in a temp dir; the SSL certs are auto-generated on first use.
const dir = mkdtempSync(join(tmpdir(), "donly-proxy-"));
const manifest = join(dir, "manifest.donly");
writeFileSync(
  manifest,
  `proxy {
  host "127.0.0.1"
  port 0
  ssl {
    cert "./certs/cert.pem"
    key "./certs/key.pem"
  }
  route POST http://example.com/ {
    respond 201 "created"
  }
  route https?://example.com/ {
    respond 200 "good"
  }
}
`,
);
const config = await loadConfig(manifest);
const server = createProxyServer(config);
let proxy: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

test("GET http://example.com through the proxy responds ok", async () => {
  const res = await fetch("http://example.com", { proxy });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("good");
});

test("GET https://example.com through the proxy responds ok", async () => {
  const res = await fetch("https://example.com", {
    proxy,
    tls: { rejectUnauthorized: false },
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("good");
});

test("manifest.donly configures the proxy", () => {
  expect(config.host).toBe("127.0.0.1");
  expect(config.port).toBe(0);
  expect(config.ssl.cert.endsWith("certs/cert.pem")).toBe(true);
});

test("route can be limited by method", async () => {
  const get = await fetch("http://example.com", { proxy });
  expect(await get.text()).toBe("good");
  const post = await fetch("http://example.com", { proxy, method: "POST" });
  expect(post.status).toBe(201);
  expect(await post.text()).toBe("created");
});

test("requests that match no route respond ok", async () => {
  const res = await fetch("http://other.test/x", { proxy });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});
