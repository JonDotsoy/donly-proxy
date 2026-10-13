import { expect } from "bun:test";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-host-"));
const load = async (payload: string) => {
  const file = join(dir, `manifest-${Math.random()}.donly`);
  writeFileSync(file, payload);
  return loadConfig(file);
};

// Without `host` the proxy only listens on the loopback interface.
const withoutHost = `proxy {
  port 0
  route {
    respond 200 "ok"
  }
}
`;

testFeature(withoutHost, ["/proxy/host"], "should default the host to 127.0.0.1 when the manifest has none", async (payload) => {
  expect((await load(payload)).host).toBe("127.0.0.1");
});

testFeature(withoutHost, ["/proxy/host"], "should listen on 127.0.0.1 when the manifest has no host", async (payload) => {
  const config = await load(payload);
  const server = createProxyServer(config);
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  try {
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
    const res = await fetch("http://example.com/", { proxy: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    expect(await res.text()).toBe("ok");
  } finally {
    server.close();
  }
});

testFeature(`proxy {\n  host "0.0.0.0"\n  port 0\n}\n`, ["/proxy/host"], "should keep the host declared in the manifest", async (payload) => {
  expect((await load(payload)).host).toBe("0.0.0.0");
});
