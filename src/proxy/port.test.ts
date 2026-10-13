import { expect } from "bun:test";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-port-"));
const load = async (payload: string) => {
  const file = join(dir, `manifest-${Math.random()}.donly`);
  writeFileSync(file, payload);
  return loadConfig(file);
};

// Without `port` the proxy asks the system for a free one.
const withoutPort = `proxy {
  host "127.0.0.1"
  route {
    respond 200 "ok"
  }
}
`;

testFeature(withoutPort, ["/proxy/port"], "should default the port to 0 when the manifest has none", async (payload) => {
  expect((await load(payload)).port).toBe(0);
});

testFeature(withoutPort, ["/proxy/port"], "should listen on a random free port when the manifest has none", async (payload) => {
  const config = await load(payload);
  const servers = [createProxyServer(config), createProxyServer(config)];
  try {
    const ports = await Promise.all(
      servers.map(
        (server) =>
          new Promise<number>((resolve) => server.listen(config.port, config.host, () => resolve((server.address() as AddressInfo).port))),
      ),
    );
    expect(ports[0]).toBeGreaterThan(0);
    expect(ports[1]).toBeGreaterThan(0);
    expect(ports[0]).not.toBe(ports[1]);
    const res = await fetch("http://example.com/", { proxy: `http://127.0.0.1:${ports[0]}` });
    expect(await res.text()).toBe("ok");
  } finally {
    for (const server of servers) server.close();
  }
});

testFeature(`proxy {\n  host "127.0.0.1"\n  port 3456\n}\n`, ["/proxy/port"], "should keep the port declared in the manifest", async (payload) => {
  expect((await load(payload)).port).toBe(3456);
});
