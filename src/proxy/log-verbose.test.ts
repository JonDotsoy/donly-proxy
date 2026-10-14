import { afterAll, beforeAll, expect, spyOn } from "bun:test";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-verbose-"));
const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  log verbose
  route http://verbose.test/ {
    respond 200 "hi"
  }
}
`;
writeFileSync(join(dir, "manifest.donly"), manifestPayload);

const saved = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
let server: ReturnType<typeof createProxyServer>;
let proxy: string;

beforeAll(async () => {
  process.env.NO_PROXY = process.env.no_proxy = "";
  server = createProxyServer(await loadConfig(join(dir, "manifest.donly")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  process.env.NO_PROXY = saved.NO_PROXY;
  process.env.no_proxy = saved.no_proxy;
});

testFeature(manifestPayload, ["/proxy/log(verbose)", "/proxy/route/respond"], "should print the request and the matched route to stderr when log verbose is set", async () => {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await (await fetch("http://verbose.test/", { proxy })).text()).toBe("hi");
    const lines = spy.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain("[verbose] GET http://verbose.test/");
    expect(lines.some((l) => l.startsWith("[verbose] route ") && l.endsWith("-> respond"))).toBe(true);
    expect(lines).toContain("[verbose] response 200");
  } finally {
    spy.mockRestore();
  }
});

testFeature(`proxy {\n  host "127.0.0.1"\n  port 0\n}\n`, ["/proxy/port"], "should stay silent without log verbose", async (payload) => {
  const quiet = join(dir, "quiet.donly");
  writeFileSync(quiet, payload);
  const other = createProxyServer(await loadConfig(quiet));
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    await fetch("http://verbose.test/", { proxy: `http://127.0.0.1:${(other.address() as AddressInfo).port}` });
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    other.close();
  }
});

testFeature(`proxy {\n  log loud\n}\n`, ["/proxy/log"], "should reject a log value other than verbose", async (payload) => {
  const bad = join(dir, "bad.donly");
  writeFileSync(bad, payload);
  expect(loadConfig(bad)).rejects.toThrow('log loud: solo se soporta "log verbose"');
});
