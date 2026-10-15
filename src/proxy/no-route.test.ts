import { afterAll, beforeAll, expect } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-no-route-"));
const manifest = join(dir, "manifest.donly");
const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  ssl {
    cert "./certs/cert.pem"
    key "./certs/key.pem"
  }
}
`;
writeFileSync(manifest, manifestPayload);

let server: Server;
let upstream: ReturnType<typeof Bun.serve>;
let proxy: string;
const savedNoProxy = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };

beforeAll(async () => {
  process.env.NO_PROXY = process.env.no_proxy = "";
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => new Response(`${req.method} ${new URL(req.url).pathname}${new URL(req.url).search} ${await req.text()}`, { status: 201, headers: { "x-upstream": "yes" } }),
  });
  server = createProxyServer(await loadConfig(manifest));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  upstream.stop(true);
  for (const [k, v] of Object.entries(savedNoProxy)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

testFeature(manifestPayload, ["/proxy"], "a proxy without routes forwards the request unchanged to its own URL", async () => {
  const res = await fetch(`http://127.0.0.1:${upstream.port}/a/b?x=1`, { proxy, method: "POST", body: "hola" });
  expect(res.status).toBe(201);
  expect(res.headers.get("x-upstream")).toBe("yes");
  expect(await res.text()).toBe("POST /a/b?x=1 hola");
});
