import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "./server";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-catchall-"));
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
  route http://specific.test/ {
    respond 200 "specific"
  }
  route {
    respond 202 "catch-all"
  }
  route http://never.test/ {
    respond 200 "unreachable"
  }
}
`,
);

let server: Server;
let proxy: string;

beforeAll(async () => {
  server = createProxyServer(await loadConfig(manifest));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

const insecure = { rejectUnauthorized: false };

test("[route.catch-all] a route without arguments matches every request", async () => {
  for (const url of ["http://any.test/", "http://other.test/a/b?c=d"]) {
    const res = await fetch(url, { proxy });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("catch-all");
  }
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = await fetch("http://any.test/", { proxy, method, body: method === "DELETE" ? undefined : "x" });
    expect(res.status).toBe(202);
  }
  const https = await fetch("https://secure.test/path", { proxy, tls: insecure });
  expect(https.status).toBe(202);
  expect(await https.text()).toBe("catch-all");
});

test("[route.catch-all] its pattern is a real wildcard, not the text 'undefined'", async () => {
  const config = await loadConfig(manifest);
  const route = config.routes[1]!;
  expect(route.method).toBeNull();
  expect(route.pattern.test("http://anything.example/")).toBe(true);
  expect(route.pattern.test("")).toBe(true);
});

test("[route.catch-all.order] earlier routes win and the catch-all takes the rest", async () => {
  const specific = await fetch("http://specific.test/", { proxy });
  expect(specific.status).toBe(200);
  expect(await specific.text()).toBe("specific");
  // Declared after the catch-all, so it can never be reached.
  const never = await fetch("http://never.test/", { proxy });
  expect(await never.text()).toBe("catch-all");
});
