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

// IPv6: `::1` is the loopback address and `::` all the interfaces.
for (const host of ["::1", "::"]) {
  testFeature(
    `proxy {\n  host "${host}"\n  port 0\n  route {\n    respond 200 "ok"\n  }\n}\n`,
    ["/proxy/host"],
    `should listen on the IPv6 host ${host}`,
    async (payload) => {
      const config = await load(payload);
      expect(config.host).toBe(host);
      const server = createProxyServer(config);
      await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
      try {
        const { address, family, port } = server.address() as AddressInfo;
        expect(address).toBe(host);
        expect(family).toBe("IPv6");
        // The proxy URL brackets the IPv6 address.
        const res = await fetch("http://example.com/", { proxy: `http://[::1]:${port}` });
        expect(await res.text()).toBe("ok");
      } finally {
        server.close();
      }
    },
  );
}

// Other notations of the same IPv6 loopback address: the proxy listens on `::1` whatever the spelling.
for (const host of ["0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "::0001", "0::1", "[::1]"]) {
  testFeature(
    `proxy {\n  host "${host}"\n  port 0\n  route {\n    respond 200 "ok"\n  }\n}\n`,
    ["/proxy/host"],
    `should accept the IPv6 notation ${host}`,
    async (payload) => {
      const config = await load(payload);
      const server = createProxyServer(config);
      await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
      try {
        const { address, family, port } = server.address() as AddressInfo;
        expect(address).toBe("::1");
        expect(family).toBe("IPv6");
        const res = await fetch("http://example.com/", { proxy: `http://[::1]:${port}` });
        expect(await res.text()).toBe("ok");
      } finally {
        server.close();
      }
    },
  );
}

// An IPv4-mapped IPv6 address is reachable through its IPv4 form.
testFeature(
  `proxy {\n  host "::ffff:127.0.0.1"\n  port 0\n  route {\n    respond 200 "ok"\n  }\n}\n`,
  ["/proxy/host"],
  "should accept the IPv4-mapped IPv6 notation ::ffff:127.0.0.1",
  async (payload) => {
    const config = await load(payload);
    const server = createProxyServer(config);
    await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
    try {
      const res = await fetch("http://example.com/", { proxy: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
      expect(await res.text()).toBe("ok");
    } finally {
      server.close();
    }
  },
);
