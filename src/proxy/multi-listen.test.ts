import { afterAll, beforeAll, expect } from "bun:test";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServers, loadConfig } from "./server";
import { lintManifest } from "./lint";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-multi-listen-"));
let savedNoProxy: [string | undefined, string | undefined];

beforeAll(() => {
  savedNoProxy = [process.env.NO_PROXY, process.env.no_proxy];
  for (const name of ["NO_PROXY", "no_proxy"]) process.env[name] = "";
});
afterAll(() => {
  [process.env.NO_PROXY, process.env.no_proxy] = savedNoProxy;
});

const curl = async (...args: string[]) => {
  const proc = Bun.spawn(["curl", "-sS", "-k", "--proxy-insecure", "--max-time", "4", ...args], { stdout: "pipe", stderr: "pipe" });
  return new Response(proc.stdout).text();
};

const start = async (name: string, payload: string) => {
  const file = join(dir, `${name}.donly`);
  writeFileSync(file, payload);
  const config = await loadConfig(file);
  const servers = createProxyServers(config);
  const ports = await Promise.all(
    servers.map(
      (s, i) =>
        new Promise<number>((resolve) =>
          s.listen(config.listeners[i]!.port, config.listeners[i]!.host, () => resolve((s.address() as AddressInfo).port)),
        ),
    ),
  );
  return { config, servers, ports, close: () => servers.forEach((s) => s.close()) };
};

const routes = `
  route http://example.com/* {
    respond 200 "shared good"
  }
  route https://example.com/* {
    respond 200 "shared good"
  }
`;

testFeature(`proxy {\n  listen http 9080\n  listen https 9081\n}\n`, ["/proxy/listen"], "should parse several listen into one listener each", async (payload) => {
  const file = join(dir, "parse.donly");
  writeFileSync(file, payload);
  const config = await loadConfig(file);
  expect(config.listeners.map((l) => [l.host, l.port, l.https !== undefined])).toEqual([
    ["127.0.0.1", 9080, false],
    ["127.0.0.1", 9081, true],
  ]);
  expect(config.port).toBe(9080);
});

testFeature(`proxy {\n  listen http 127.0.0.1 0\n  listen https 127.0.0.1 0${routes}}\n`, ["/proxy/listen", "/proxy/route/respond"], "should serve http and https listeners at once", async (payload) => {
  const proxy = await start("http-https", payload);
  try {
    const [httpPort, httpsPort] = proxy.ports;
    expect(await curl("--proxy", `http://127.0.0.1:${httpPort}`, "http://example.com/")).toBe("shared good");
    expect(await curl("--proxy", `https://127.0.0.1:${httpsPort}`, "http://example.com/")).toBe("shared good");
    expect(await curl("--proxy", `https://127.0.0.1:${httpsPort}`, "https://example.com/")).toBe("shared good");
  } finally {
    proxy.close();
  }
});

testFeature(`proxy {\n  listen http 127.0.0.1 0\n  listen http 127.0.0.1 0${routes}}\n`, ["/proxy/listen", "/proxy/route/respond"], "should serve two http listeners on different ports", async (payload) => {
  const proxy = await start("two-http", payload);
  try {
    expect(proxy.ports[0]).not.toBe(proxy.ports[1]);
    for (const port of proxy.ports) {
      expect(await curl("--proxy", `http://127.0.0.1:${port}`, "http://example.com/")).toBe("shared good");
    }
  } finally {
    proxy.close();
  }
});

testFeature(`proxy {\n  listen http 127.0.0.1 9090\n  listen https 127.0.0.1 9090\n}\n`, ["/proxy/listen"], "should reject two listen on the same host and port", async (payload) => {
  const file = join(dir, "conflict.donly");
  writeFileSync(file, payload);
  expect(loadConfig(file)).rejects.toThrow("listen: 127.0.0.1:9090 está declarado más de una vez");
});

testFeature(`proxy {\n  listen http 127.0.0.1 9090\n  listen http ::1 9090\n}\n`, ["/proxy/listen"], "should allow the same port on different hosts", async (payload) => {
  const file = join(dir, "same-port.donly");
  writeFileSync(file, payload);
  expect((await loadConfig(file)).listeners).toHaveLength(2);
});

testFeature(`proxy {\n  port 9080\n  port https 9081\n}\n`, ["/proxy/port"], "should accept several port aliases", async (payload) => {
  const file = join(dir, "ports.donly");
  writeFileSync(file, payload);
  const config = await loadConfig(file);
  expect(config.listeners.map((l) => [l.port, l.https !== undefined])).toEqual([[9080, false], [9081, true]]);
});

testFeature(`proxy {\n  listen http 9080\n  port 9081\n}\n`, ["/proxy/listen", "/proxy/port"], "should still reject listen mixed with port", async (payload) => {
  const file = join(dir, "mixed.donly");
  writeFileSync(file, payload);
  expect(loadConfig(file)).rejects.toThrow("listen y port no se pueden declarar a la vez");
});

testFeature(`proxy {\n  listen http 9080\n  listen https 9081\n}\n`, ["/proxy/listen"], "should lint several listen without warnings", (payload) => {
  expect(lintManifest(payload)).toEqual([]);
});
