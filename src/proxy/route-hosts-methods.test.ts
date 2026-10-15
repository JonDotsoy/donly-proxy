import { afterAll, beforeAll, expect } from "bun:test";
import http from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

// Every method Node knows, except CONNECT, which opens a tunnel instead of being routed.
const methods = http.METHODS.filter((method) => method !== "CONNECT");
const statusOf = (method: string) => 400 + methods.indexOf(method);

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-hosts-methods-"));
const manifest = join(dir, "manifest.donly");
const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  ssl {
    cert "./certs/cert.pem"
    key "./certs/key.pem"
  }
  route "192.0.2.1" {
    respond 200 "ipv4 exact"
  }
  route "198.51.100.7/api/*" {
    respond 200 "ipv4 path"
  }
  route "203.0.113.7:8080" {
    respond 200 "ipv4 port"
  }
  route "[2001\\:db8\\:\\:1]" {
    respond 200 "ipv6 exact"
  }
  route "[2001\\:db8\\:\\:2]:8080" {
    respond 200 "ipv6 port"
  }
  route "https://[2001\\:db8\\:\\:3]/api/*" {
    respond 200 "ipv6 https path"
  }
${methods.map((method) => `  route ${method} "http://methods.test/*" {\n    respond ${statusOf(method)} "${method}"\n  }`).join("\n")}
  route "http://lower.test/*" {
    respond 200 "any"
  }
}
`;
writeFileSync(manifest, manifestPayload);

let server: Server;
let proxyPort: number;

beforeAll(async () => {
  server = createProxyServer(await loadConfig(manifest));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxyPort = (server.address() as AddressInfo).port;
});

afterAll(() => server.close());

/** Sends `method url` through the proxy with the absolute-form request target. */
const send = (method: string, url: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method, path: url, headers: { host: new URL(url).host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });

const body = async (url: string) => (await send("GET", url)).body;

testFeature(manifestPayload, ["/proxy/route/respond"], "a route matches an ipv4 host, a path and a port", async () => {
  expect(await body("http://192.0.2.1/")).toBe("ipv4 exact");
  expect(await body("https://192.0.2.1/a?x=1")).toBe("ipv4 exact");
  expect(await body("http://192.0.2.2/")).toBe("ok");
  expect(await body("http://198.51.100.7/api/users")).toBe("ipv4 path");
  expect(await body("http://198.51.100.7/other")).toBe("ok");
  expect(await body("http://203.0.113.7:8080/x")).toBe("ipv4 port");
  expect(await body("http://203.0.113.7:9090/x")).toBe("ok");
});

testFeature(manifestPayload, ["/proxy/route/respond"], "a route matches an ipv6 host, a port and a scheme with path", async () => {
  expect(await body("http://[2001:db8::1]/")).toBe("ipv6 exact");
  expect(await body("http://[2001:db8::2]:8080/x")).toBe("ipv6 port");
  expect(await body("http://[2001:db8::2]:9090/x")).toBe("ok");
  expect(await body("https://[2001:db8::3]/api/users")).toBe("ipv6 https path");
  expect(await body("http://[2001:db8::3]/api/users")).toBe("ok");
  expect(await body("http://[2001:db8::99]/")).toBe("ok");
});

testFeature(manifestPayload, ["/proxy/route/respond"], "a route with a method matches each HTTP method and only that method", async () => {
  for (const method of methods) {
    const res = await send(method, "http://methods.test/resource?x=1");
    expect(res.status).toBe(statusOf(method));
    if (method !== "HEAD") expect(res.body).toBe(method);
  }
});

testFeature(manifestPayload, ["/proxy/route/respond"], "a route without a method matches every HTTP method", async () => {
  for (const method of methods) {
    expect((await send(method, "http://lower.test/")).status).toBe(200);
  }
});

testFeature(`proxy {\n  route get "http://lower.test/*" {\n    respond 201 "lower"\n  }\n}\n`, ["/proxy/route"], "should accept the method in lowercase", async (payload) => {
  const file = join(dir, "lower.donly");
  writeFileSync(file, payload);
  const config = await loadConfig(file);
  expect(config.routes[0]!.method).toBe("GET");
});
