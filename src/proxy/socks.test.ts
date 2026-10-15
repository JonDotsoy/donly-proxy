import { afterAll, beforeAll, expect } from "bun:test";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, createProxyServers, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-socks-"));
const upstream = http.createServer((_req, res) => res.end("from upstream"));

// The proxy never dials the destination of the tunnel: like CONNECT, the tunnel ends in the proxy
// and the routes answer the requests inside it. 192.0.2.1 is TEST-NET: it is not reachable.
const manifestPayload = (version: 4 | 5, port: number) => `proxy {
  listen socks${version} 127.0.0.1 0
  log_file "./socks${version}.ndjson"
  route http://upstream.test/* {
    proxy_pass http://127.0.0.1:${port}/
  }
  route http://192.0.2.1/* {
    proxy_pass http://127.0.0.1:${port}/
  }
  route https://secure.test/* {
    respond 200 "secure good"
  }
  route https://192.0.2.1/* {
    respond 200 "secure ip good"
  }
  route https://192.0.2.1:8443/* {
    respond 200 "secure port good"
  }
  route "https://[2001\\:db8\\:\\:1]/*" {
    respond 200 "secure ipv6 good"
  }
}
`;

const servers: Record<4 | 5, { server: ReturnType<typeof createProxyServer>; port: number }> = {} as never;
let upstreamPort: number;

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
  for (const version of [4, 5] as const) {
    const file = join(dir, `socks${version}.donly`);
    writeFileSync(file, manifestPayload(version, upstreamPort));
    const server = createProxyServer(await loadConfig(file));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers[version] = { server, port: (server.address() as AddressInfo).port };
  }
});

afterAll(() => {
  for (const { server } of Object.values(servers)) server.close();
  upstream.close();
});

const curl = async (...args: string[]) => {
  const proc = Bun.spawn(["curl", "-sS", "-k", "--max-time", "4", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { out, err, code: await proc.exited };
};

const variants = [
  { flag: "--socks4", version: 4, hostnames: false },
  { flag: "--socks4a", version: 4, hostnames: true },
  { flag: "--socks5", version: 5, hostnames: false },
  { flag: "--socks5-hostname", version: 5, hostnames: true },
] as const;

for (const { flag, version, hostnames } of variants) {
  const payload = manifestPayload(version, 0);
  const proxy = () => `127.0.0.1:${servers[version].port}`;

  testFeature(payload, ["/proxy/listen", "/proxy/route/proxy_pass"], `should proxy_pass an http request through curl ${flag}`, async () => {
    const res = await curl(flag, proxy(), hostnames ? "http://upstream.test/" : "http://192.0.2.1/");
    expect(res.err).toBe("");
    expect(res.out).toBe("from upstream");
  });

  testFeature(payload, ["/proxy/listen", "/proxy/route/respond"], `should tunnel an https request through curl ${flag}`, async () => {
    const res = await curl(flag, proxy(), hostnames ? "https://secure.test/" : "https://192.0.2.1/");
    expect(res.err).toBe("");
    expect(res.out).toBe(hostnames ? "secure good" : "secure ip good");
  });
}

testFeature(manifestPayload(5, 0), ["/proxy/listen", "/proxy/route/respond"], "should keep a non default port of the target in the url the routes see", async () => {
  const res = await curl("--socks5-hostname", `127.0.0.1:${servers[5].port}`, "https://192.0.2.1:8443/");
  expect(res.out).toBe("secure port good");
});

testFeature(manifestPayload(5, 0), ["/proxy/listen", "/proxy/route/respond"], "should tunnel an https request to an ipv6 target through curl --socks5", async () => {
  const res = await curl("--socks5", `127.0.0.1:${servers[5].port}`, "-g", "https://[2001:db8::1]/");
  expect(res.out).toBe("secure ipv6 good");
});

testFeature(manifestPayload(4, 0), ["/proxy/listen"], "should answer 200 ok through a tunnel when no route matches", async () => {
  const res = await curl("--socks4a", `127.0.0.1:${servers[4].port}`, "http://nomatch.test/");
  expect(res.out).toBe("ok");
});

testFeature(manifestPayload(5, 0), ["/proxy/listen", "/proxy/log_file"], "should log the requests carried by a socks tunnel with the full url", async () => {
  await curl("--socks5-hostname", `127.0.0.1:${servers[5].port}`, "https://secure.test/logged");
  const lines = readFileSync(join(dir, "socks5.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  expect(lines[0]).toMatchObject({ type: "listening", host: "127.0.0.1", port: servers[5].port });
  expect(lines.find((l) => l.type === "request" && l.url === "https://secure.test/logged")).toBeDefined();
  expect(lines.find((l) => l.type === "response" && l.status === 200)).toBeDefined();
});

/** Sends `bytes` to the proxy and resolves with everything it answers until it closes the connection. */
const raw = (port: number, bytes: number[]) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, "127.0.0.1", () => socket.write(Buffer.from(bytes)));
    socket.on("data", (c) => chunks.push(c));
    socket.on("error", () => {});
    socket.on("close", () => resolve(Buffer.concat(chunks)));
    setTimeout(() => socket.destroy(), 1000);
  });

testFeature(manifestPayload(4, 0), ["/proxy/listen"], "should reject a socks4 BIND request", async () => {
  const reply = await raw(servers[4].port, [4, 2, 0, 80, 1, 2, 3, 4, 0]);
  expect([...reply]).toEqual([0, 0x5b, 0, 0, 0, 0, 0, 0]);
});

testFeature(manifestPayload(5, 0), ["/proxy/listen"], "should reject a socks5 client that does not offer no-auth", async () => {
  const reply = await raw(servers[5].port, [5, 1, 2]);
  expect([...reply]).toEqual([5, 0xff]);
});

testFeature(manifestPayload(5, 0), ["/proxy/listen"], "should reject a socks5 UDP ASSOCIATE request", async () => {
  const reply = await raw(servers[5].port, [5, 1, 0, 5, 3, 0, 1, 1, 2, 3, 4, 0, 80]);
  expect([...reply]).toEqual([5, 0, 5, 7, 0, 1, 0, 0, 0, 0, 0, 0]);
});

testFeature(manifestPayload(5, 0), ["/proxy/listen"], "should close a connection that does not speak the configured socks version", async () => {
  const reply = await raw(servers[5].port, [4, 1, 0, 80, 1, 2, 3, 4, 0]);
  expect(reply.length).toBe(0);
});

for (const [body, expected] of [
  ["listen socks4", { host: "127.0.0.1", port: 0, socks: 4 }],
  ["listen socks5 8080", { host: "127.0.0.1", port: 8080, socks: 5 }],
  ["listen socks5 127.0.0.1 0", { host: "127.0.0.1", port: 0, socks: 5 }],
  ["listen socks4 ::1 0", { host: "::1", port: 0, socks: 4 }],
  ['host "::1"\n  listen socks5 0', { host: "::1", port: 0, socks: 5 }],
] as const) {
  testFeature(`proxy {\n  ${body}\n}\n`, ["/proxy/listen"], `should parse the syntax: ${body.replace("\n  ", "; ")}`, async (payload) => {
    const file = join(dir, `syntax-${Math.random()}.donly`);
    writeFileSync(file, payload);
    const { listeners } = await loadConfig(file);
    expect(listeners).toHaveLength(1);
    expect(listeners[0]).toMatchObject(expected);
  });
}

const mixedPayload = `proxy {
  listen http 127.0.0.1 0
  listen socks5 127.0.0.1 0
  route http://mixed.test/* {
    respond 200 "mixed good"
  }
}
`;

testFeature(mixedPayload, ["/proxy/listen", "/proxy/route/respond"], "should serve an http listener and a socks5 listener of the same block", async () => {
  const file = join(dir, "mixed.donly");
  writeFileSync(file, mixedPayload);
  const mixed = createProxyServers(await loadConfig(file));
  try {
    expect(mixed).toHaveLength(2);
    for (const server of mixed) await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const [httpPort, socksPort] = mixed.map((server) => (server.address() as AddressInfo).port);
    const viaHttp = await curl("--proxy", `http://127.0.0.1:${httpPort}`, "http://mixed.test/");
    const viaSocks = await curl("--socks5-hostname", `127.0.0.1:${socksPort}`, "http://mixed.test/");
    expect([viaHttp.out, viaSocks.out]).toEqual(["mixed good", "mixed good"]);
  } finally {
    for (const server of mixed) server.close();
  }
});
