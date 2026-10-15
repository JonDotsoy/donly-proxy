import { afterAll, beforeAll, expect } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-routeargs-"));
const manifest = join(dir, "manifest.donly");
const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  ssl {
    cert "./certs/cert.pem"
    key "./certs/key.pem"
  }
  route POST http://method.test/ {
    respond 201 "post only"
  }
  route http://any.test/ {
    respond 200 "any method"
  }
}
`;
writeFileSync(manifest, manifestPayload);

let server: Server;
let proxy: string;

beforeAll(async () => {
  server = createProxyServer(await loadConfig(manifest));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

testFeature(manifestPayload, ["/proxy/route"], "a route with one argument validates only the URL", async () => {
  for (const method of ["GET", "POST", "PUT"]) {
    const res = await fetch("http://any.test/", { proxy, method, body: method === "GET" ? undefined : "x" });
    expect(await res.text()).toBe("any method");
  }
});

testFeature(manifestPayload, ["/proxy/route"], "a route with two arguments validates the method and the URL", async () => {
  const post = await fetch("http://method.test/", { proxy, method: "POST", body: "x" });
  expect(post.status).toBe(201);
  expect(await post.text()).toBe("post only");
  expect(await (await fetch("http://method.test/", { proxy })).text()).toBe("ok");
});

testFeature(`proxy {\n  route GET POST http://x.test/ {\n    respond 200 "x"\n  }\n}\n`, ["/proxy/route"], "should reject a route with more than two arguments", async (payload) => {
  const bad = join(dir, "bad.donly");
  writeFileSync(bad, payload);
  expect(loadConfig(bad)).rejects.toThrow("route recibe un patrón o un método y un patrón");
});
