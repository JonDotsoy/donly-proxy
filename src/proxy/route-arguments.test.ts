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
  route POST http://method.test/* {
    respond 201 "post only"
  }
  route http://any.test/* {
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

testFeature(`proxy {\n  route FETCH http://x.test/ {\n    respond 200 "x"\n  }\n}\n`, ["/proxy/route"], "should reject a method that is not in the list of methods", async (payload) => {
  const bad = join(dir, "bad-method.donly");
  writeFileSync(bad, payload);
  expect(loadConfig(bad)).rejects.toThrow("el método debe ser uno de");
});

const threeFormats = `proxy {
  host "127.0.0.1"
  port 0
  ssl {
    cert "./certs/cert.pem"
    key "./certs/key.pem"
  }
  route POST "http://formats.test/*" {
    respond 201 "method and url"
  }
  route "http://formats.test/*" {
    respond 202 "url only"
  }
  route {
    respond 203 "no arguments"
  }
}
`;
testFeature(threeFormats, ["/proxy/route", "/proxy/route()"], "the three formats of route are evaluated in order", async () => {
  const dir3 = mkdtempSync(join(tmpdir(), "donly-proxy-routeformats-"));
  const file = join(dir3, "manifest.donly");
  writeFileSync(file, threeFormats);
  const formatsServer = createProxyServer(await loadConfig(file));
  await new Promise<void>((resolve) => formatsServer.listen(0, "127.0.0.1", resolve));
  const via = `http://127.0.0.1:${(formatsServer.address() as AddressInfo).port}`;
  try {
    const post = await fetch("http://formats.test/a", { proxy: via, method: "POST", body: "x" });
    expect([post.status, await post.text()]).toEqual([201, "method and url"]);
    const get = await fetch("http://formats.test/a", { proxy: via });
    expect([get.status, await get.text()]).toEqual([202, "url only"]);
    const other = await fetch("http://other.test/", { proxy: via });
    expect([other.status, await other.text()]).toEqual([203, "no arguments"]);
  } finally {
    formatsServer.close();
  }
});
