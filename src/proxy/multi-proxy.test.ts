import { afterAll, beforeAll, expect } from "bun:test";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServers, loadConfigs } from "./server";
import { lintManifest } from "./lint";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-multi-proxy-"));
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

const manifest = (listenHttp: string, listenHttps: string) => `proxy {
  listen http ${listenHttp}
  route {
    respond 200 "ok http"
  }
}
proxy {
  listen https ${listenHttps}
  route {
    respond 200 "ok https"
  }
}
`;

testFeature(manifest("8090", "8091"), ["/proxy", "/proxy/listen"], "should parse each proxy block with its own listen", async (payload) => {
  const file = join(dir, "parse.donly");
  writeFileSync(file, payload);
  const configs = await loadConfigs(file);
  expect(configs.map((c) => c.listeners.map((l) => [l.port, l.https !== undefined]))).toEqual([[[8090, false]], [[8091, true]]]);
  expect(configs.map((c) => c.routes[0]!.action)).toEqual([
    { kind: "respond", status: 200, body: "ok http" },
    { kind: "respond", status: 200, body: "ok https" },
  ]);
});

testFeature(manifest("127.0.0.1 0", "127.0.0.1 0"), ["/proxy", "/proxy/listen", "/proxy/route/respond"], "should answer each proxy block with its own route", async (payload) => {
  const file = join(dir, "serve.donly");
  writeFileSync(file, payload);
  const servers = (await loadConfigs(file)).flatMap((config) => {
    return createProxyServers(config).map((server) => ({ server, config }));
  });
  const [httpPort, httpsPort] = await Promise.all(
    servers.map(
      ({ server, config }) =>
        new Promise<number>((resolve) => server.listen(config.listeners[0]!.port, config.listeners[0]!.host, () => resolve((server.address() as AddressInfo).port))),
    ),
  );
  try {
    expect(await curl("--proxy", `http://127.0.0.1:${httpPort}`, "http://example.com/")).toBe("ok http");
    expect(await curl("--proxy", `https://127.0.0.1:${httpsPort}`, "http://example.com/")).toBe("ok https");
  } finally {
    servers.forEach(({ server }) => server.close());
  }
});

testFeature(manifest("9090", "9090"), ["/proxy", "/proxy/listen"], "should reject the same host and port in two proxy blocks", async (payload) => {
  const file = join(dir, "conflict.donly");
  writeFileSync(file, payload);
  expect(loadConfigs(file)).rejects.toThrow("listen: 127.0.0.1:9090 está declarado más de una vez");
});

testFeature(manifest("8090", "8091"), ["/proxy"], "should lint several proxy blocks without warnings", (payload) => {
  expect(lintManifest(payload)).toEqual([]);
});
