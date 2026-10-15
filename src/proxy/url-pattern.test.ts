import { afterAll, beforeAll, expect } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { compileRoutePattern } from "./route-pattern";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-urlpattern-"));
const manifest = join(dir, "manifest.donly");
const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  ssl {
    cert "./certs/cert.pem"
    key "./certs/key.pem"
  }
  route "urlpattern:only.test" {
    respond 200 "host only"
  }
  route "urlpattern:port.test:8080" {
    respond 200 "host and port"
  }
  route "urlpattern:*.wild.test" {
    respond 200 "wildcard"
  }
  route "urlpattern:path.test/api/*" {
    respond 200 "host and path"
  }
  route "urlpattern:https://secure.test/*" {
    respond 200 "https only"
  }
  route "urlpattern:http{s}?://both.test/*" {
    respond 200 "both schemes"
  }
  route GET https?://regex.test/ {
    respond 200 "regex"
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

const body = async (url: string) => (await fetch(url, { proxy, tls: { rejectUnauthorized: false } })).text();

testFeature(manifestPayload, ["/proxy/route/respond"], "a urlpattern with only a host matches any scheme, path and query", async () => {
  expect(await body("http://only.test/")).toBe("host only");
  expect(await body("http://only.test/a/b?x=1")).toBe("host only");
  expect(await body("https://only.test/a")).toBe("host only");
  expect(await body("http://other.only.test/")).toBe("ok");
  expect(await body("http://only.test.evil/")).toBe("ok");
});

testFeature(manifestPayload, ["/proxy/route/respond"], "a urlpattern with host and port matches only that port", async () => {
  expect(await body("http://port.test:8080/x")).toBe("host and port");
  expect(await body("http://port.test:9090/x")).toBe("ok");
  expect(await body("http://port.test/x")).toBe("ok");
});

testFeature(manifestPayload, ["/proxy/route/respond"], "a urlpattern supports wildcards in the host and path", async () => {
  expect(await body("http://a.wild.test/")).toBe("wildcard");
  expect(await body("http://a.b.wild.test/")).toBe("wildcard");
  expect(await body("http://wild.test/")).toBe("ok");
  expect(await body("http://path.test/api/users")).toBe("host and path");
  expect(await body("http://path.test/other")).toBe("ok");
});

testFeature(manifestPayload, ["/proxy/route/respond"], "a urlpattern with a scheme restricts the protocol", async () => {
  expect(await body("https://secure.test/a")).toBe("https only");
  expect(await body("http://secure.test/a")).toBe("ok");
  expect(await body("http://both.test/")).toBe("both schemes");
  expect(await body("https://both.test/")).toBe("both schemes");
});

testFeature(manifestPayload, ["/proxy/route/respond"], "a pattern without the urlpattern prefix is still a regular expression", async () => {
  expect(await body("http://regex.test/")).toBe("regex");
  expect(await body("https://regex.test/")).toBe("regex");
});

testFeature(`proxy {\n  route "urlpattern:" {\n    respond 200 "x"\n  }\n}\n`, ["/proxy/route"], "should reject an empty urlpattern", async (payload) => {
  const bad = join(dir, "bad.donly");
  writeFileSync(bad, payload);
  expect(loadConfig(bad)).rejects.toThrow("patrón inválido");
});

testFeature(`proxy {\n  route "urlpattern:http://(" {\n    respond 200 "x"\n  }\n}\n`, ["/proxy/route"], "should reject a malformed urlpattern", async (payload) => {
  const bad = join(dir, "bad2.donly");
  writeFileSync(bad, payload);
  expect(loadConfig(bad)).rejects.toThrow("patrón inválido");
});

testFeature(manifestPayload, ["/proxy/route"], "compileRoutePattern expands host shorthands", async () => {
  expect(compileRoutePattern("urlpattern:a.test").test("https://a.test:8443/x?y=1#z")).toBe(false);
  expect(compileRoutePattern("urlpattern:a.test:*").test("https://a.test:8443/x?y=1#z")).toBe(true);
});
