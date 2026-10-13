import { expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../proxy/server";
import { testFeature } from "./test-feature";

const payload = `proxy {
  host "127.0.0.1"
  port 3000
}
`;

testFeature(payload, ["/proxy/port"], "should read the port from the manifest", async (payload) => {
  const dir = mkdtempSync(join(tmpdir(), "donly-proxy-test-feature-"));
  const manifest = join(dir, "manifest.donly");
  writeFileSync(manifest, payload);
  const config = await loadConfig(manifest);
  expect(config.port).toBe(3000);
});

testFeature(payload, ["/proxy/port"], "should read the port from the manifest", async (payload) => {
  const dir = mkdtempSync(join(tmpdir(), "donly-proxy-test-feature-"));
  const manifest = join(dir, "manifest.donly");
  writeFileSync(manifest, payload);
  const config = await loadConfig(manifest);
  expect(config.port).toBe(3000);
});

testFeature(payload, ["/proxy"], "should load the proxy block of the manifest", async (payload) => {
  const dir = mkdtempSync(join(tmpdir(), "donly-proxy-test-feature-"));
  const manifest = join(dir, "manifest.donly");
  writeFileSync(manifest, payload);
  const config = await loadConfig(manifest);
  expect(config.host).toBe("127.0.0.1");
  expect(config.port).toBe(3000);
});
