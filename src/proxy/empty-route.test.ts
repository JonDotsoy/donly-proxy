import { afterAll, beforeAll, expect } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-empty-route-"));
const manifest = join(dir, "manifest.donly");
const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  ssl {
    cert "./certs/cert.pem"
    key "./certs/key.pem"
  }
  route {}
  route http://specific.test/ {}
  route http://specific.test/ {
    respond 200 "specific"
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

testFeature(manifestPayload, ["/proxy/route()"], "a route without a body loads without error and does nothing", async () => {
  const config = await loadConfig(manifest);
  expect(config.routes).toHaveLength(1);
  const res = await fetch("http://other.test/", { proxy });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

testFeature(manifestPayload, ["/proxy/route"], "an empty route does not shadow the routes declared after it", async () => {
  const res = await fetch("http://specific.test/", { proxy });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("specific");
});

const noActionPayload = `proxy {
  route http://a.test/ {
    timeout 5
  }
}
`;
testFeature(noActionPayload, ["/proxy/route"], "a route with a body but no action still fails to start", async (payload) => {
  const bad = join(dir, "bad.donly");
  writeFileSync(bad, payload);
  expect(loadConfig(bad)).rejects.toThrow("se requiere exactamente uno de");
});
