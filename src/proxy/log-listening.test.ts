import { afterAll, beforeAll, expect } from "bun:test";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-listening-"));
const logFile = join(dir, "proxy.ndjson");
const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  log_file "./proxy.ndjson"
}
`;
writeFileSync(join(dir, "manifest.donly"), manifestPayload);

let server: ReturnType<typeof createProxyServer>;

beforeAll(async () => {
  server = createProxyServer(await loadConfig(join(dir, "manifest.donly")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
afterAll(() => server.close());

testFeature(manifestPayload, ["/proxy/log_file", "/proxy/port"], "should log a listening line with the host and port when the server starts", async () => {
  const lines = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  expect(lines).toHaveLength(1);
  const { port } = server.address() as AddressInfo;
  expect(lines[0]).toMatchObject({ type: "listening", host: "127.0.0.1", port });
  expect(typeof lines[0].timestamp).toBe("string");
  expect(typeof lines[0].performance_timestamp).toBe("number");
});
