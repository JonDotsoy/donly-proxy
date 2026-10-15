import { afterAll, beforeAll, expect } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

// Upstream that echoes what it received, used by `proxy_pass` routes.
const upstream = http.createServer(async (req, res) => {
  const body = Buffer.concat(await Array.fromAsync(req)).toString();
  res.setHeader("x-upstream", "yes");
  res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, body }));
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

// Manifest in a temp dir; the SSL certs are auto-generated on first use.
const dir = mkdtempSync(join(tmpdir(), "donly-proxy-"));
const manifest = join(dir, "manifest.donly");
const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  log_file "./logs/proxy.ndjson"
  ssl {
    cert "./certs/cert.pem"
    key "./certs/key.pem"
  }
  route http{s}?://pass.test/* {
    proxy_pass "${upstreamUrl}"
  }
  route http://fixed.test/* {
    proxy_pass "${upstreamUrl}/fixed"
  }
  route http://curl.test/* {
    command_pass curl "--connect-to" "curl.test:80:${upstreamUrl.replace("http://", "")}"
  }
  route POST http://example.com/* {
    respond 201 "created"
  }
  route http{s}?://example.com/* {
    respond 200 "good"
  }
}
`;
writeFileSync(manifest, manifestPayload);
const config = await loadConfig(manifest);
const server = createProxyServer(config);
let proxy: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  upstream.close();
});

testFeature(manifestPayload, ["/proxy/route/respond"], "GET http://example.com through the proxy is answered by the route", async () => {
  const res = await fetch("http://example.com", { proxy });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("good");
});

testFeature(manifestPayload, ["/proxy/ssl", "/proxy/route/respond"], "GET https://example.com through the proxy is answered by the route", async () => {
  const res = await fetch("https://example.com", {
    proxy,
    tls: { rejectUnauthorized: false },
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("good");
});

testFeature(manifestPayload, ["/proxy/host", "/proxy/port", "/proxy/ssl"], "manifest.donly configures the proxy", () => {
  expect(config.host).toBe("127.0.0.1");
  expect(config.port).toBe(0);
  expect(config.ssl.cert.endsWith("certs/cert.pem")).toBe(true);
});

testFeature(manifestPayload, ["/proxy/route"], "route can be limited by method", async () => {
  const get = await fetch("http://example.com", { proxy });
  expect(await get.text()).toBe("good");
  const post = await fetch("http://example.com", { proxy, method: "POST" });
  expect(post.status).toBe(201);
  expect(await post.text()).toBe("created");
});

testFeature(manifestPayload, ["/proxy/route"], "requests that match no route respond ok", async () => {
  const res = await fetch("http://other.test/x", { proxy });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

testFeature(manifestPayload, ["/proxy/route/proxy_pass"], "proxy_pass forwards method, path, query and body to the target", async () => {
  const res = await fetch("http://pass.test/a/b?x=1", { proxy, method: "POST", body: "hello" });
  expect(res.headers.get("x-upstream")).toBe("yes");
  expect(await res.json()).toEqual({
    method: "POST",
    url: "/a/b?x=1",
    host: upstreamUrl.replace("http://", ""),
    body: "hello",
  });
});

testFeature(manifestPayload, ["/proxy/route/proxy_pass"], "proxy_pass works through an https tunnel", async () => {
  const res = await fetch("https://pass.test/secure", { proxy, tls: { rejectUnauthorized: false } });
  expect((await res.json()).url).toBe("/secure");
});

testFeature(manifestPayload, ["/proxy/route/proxy_pass"], "proxy_pass with a target path replaces the path", async () => {
  const res = await fetch("http://fixed.test/ignored?y=2", { proxy });
  expect((await res.json()).url).toBe("/fixed?y=2");
});

testFeature(manifestPayload, ["/proxy/log_file"], "log_file records request and response sharing a transaction id", async () => {
  const logFile = join(dir, "logs/proxy.ndjson");
  const before = readFileSync(logFile, "utf8").split("\n").filter(Boolean).length;
  await (await fetch("http://example.com/log?z=1", { proxy, method: "POST", body: "ping" })).text();

  const entries = readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(before).map((l) => JSON.parse(l));
  expect(entries).toHaveLength(2);
  const [request, response] = entries;
  expect(request.type).toBe("request");
  expect(response.type).toBe("response");
  expect(request.transaction_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(response.transaction_id).toBe(request.transaction_id);
  for (const e of entries) {
    expect(new Date(e.timestamp).toString()).not.toBe("Invalid Date");
    expect(e.http_version).toBe("HTTP/1.1");
    expect(e.method).toBe("POST");
    expect(e.url).toBe("http://example.com/log?z=1");
    expect(typeof e.headers).toBe("object");
  }
  expect(request.payload).toBe("ping");
  expect(response.status).toBe(201);
  expect(response.payload).toBe("created");
});

testFeature(`proxy {\n  log_file "./proxy.log"\n}\n`, ["/proxy/log_file"], "log_file only supports .ndjson", async (payload) => {
  const bad = join(dir, "bad.donly");
  writeFileSync(bad, payload);
  expect(loadConfig(bad)).rejects.toThrow(".ndjson");
});

const relativePayload = `proxy {
  host "127.0.0.1"
  port 0
  log_file "../out/rel.ndjson"
  ssl {
    cert "../ssl/cert.pem"
    key "../ssl/key.pem"
  }
}
`;

testFeature(relativePayload, ["/proxy/log_file", "/proxy/ssl"], "log_file and ssl are resolved relative to the manifest, not the cwd", async (payload) => {
  const base = mkdtempSync(join(tmpdir(), "donly-proxy-rel-"));
  mkdirSync(join(base, "conf"));
  const relManifest = join(base, "conf/manifest.donly");
  writeFileSync(relManifest, payload);
  const relConfig = await loadConfig(relManifest);
  const expected = join(base, "out/rel.ndjson");
  expect(relConfig.logFile).toBe(expected);
  expect(process.cwd()).not.toBe(base);

  const relServer = createProxyServer(relConfig);
  await new Promise<void>((resolve) => relServer.listen(0, "127.0.0.1", resolve));
  try {
    const relProxy = `http://127.0.0.1:${(relServer.address() as AddressInfo).port}`;
    await (await fetch("http://example.com/rel", { proxy: relProxy })).text();
  } finally {
    relServer.close();
  }

  expect(existsSync(expected)).toBe(true);
  expect(readFileSync(expected, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).type)).toEqual(["listening", "request", "response"]);
  expect(existsSync(join(process.cwd(), "out/rel.ndjson"))).toBe(false);
  // certs were resolved from the manifest dir too
  expect(existsSync(join(base, "ssl/cert.pem"))).toBe(true);
});

const snapshotPayload = `proxy {
  host "127.0.0.1"
  port 0
  log_file "./snap.ndjson"
  ssl {
    cert "./certs/cert.pem"
    key "./certs/key.pem"
  }
  route POST http://example.com/* {
    respond 201 "created"
  }
  route http{s}?://example.com/* {
    respond 200 "good"
  }
  route http://pass.test/* {
    proxy_pass "${upstreamUrl}"
  }
}
`;

testFeature(snapshotPayload, ["/proxy/log_file"], "log_file snapshot", async (payload) => {
  const snapDir = mkdtempSync(join(tmpdir(), "donly-proxy-snap-"));
  const snapManifest = join(snapDir, "manifest.donly");
  writeFileSync(snapManifest, payload);
  const snapConfig = await loadConfig(snapManifest);
  const snapServer = createProxyServer(snapConfig);
  await new Promise<void>((resolve) => snapServer.listen(0, "127.0.0.1", resolve));
  const snapProxy = `http://127.0.0.1:${(snapServer.address() as AddressInfo).port}`;
  const headers = { "user-agent": "test", accept: "*/*", "accept-encoding": "identity" };
  try {
    await (await fetch("http://example.com/", { proxy: snapProxy, headers })).text();
    await (await fetch("http://example.com/", { proxy: snapProxy, headers, method: "POST", body: "ping" })).text();
    await (await fetch("https://example.com/s?q=1", { proxy: snapProxy, headers, tls: { rejectUnauthorized: false } })).text();
    await (await fetch("http://other.test/x", { proxy: snapProxy, headers })).text();
    await (await fetch("http://pass.test/up?a=b", { proxy: snapProxy, headers })).text();
  } finally {
    snapServer.close();
  }

  // Mask what changes between runs: timestamps, UUIDs (kept distinguishable) and ports.
  const ids = new Map<string, string>();
  const masked = readFileSync(join(snapDir, "snap.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type !== "listening")
    .map((entry) => {
      entry.timestamp = "<timestamp>";
      delete entry.performance_timestamp; // a high-resolution clock reading: never the same twice
      if (entry.headers.date) entry.headers.date = "<date>";
      if (!ids.has(entry.transaction_id)) ids.set(entry.transaction_id, `<transaction-${[...ids.values()].filter((v) => v.startsWith("<transaction-")).length + 1}>`);
      entry.transaction_id = ids.get(entry.transaction_id);
      for (const key of ["span_id", "parent_span_id"]) {
        if (entry[key] === undefined) continue;
        if (!ids.has(entry[key])) ids.set(entry[key], `<span-${[...ids.values()].filter((v) => v.startsWith("<span-")).length + 1}>`);
        entry[key] = ids.get(entry[key]);
      }
      return JSON.parse(JSON.stringify(entry).replaceAll(upstreamUrl.split(":").pop()!, "<port>"));
    });

  expect(masked).toMatchSnapshot();
});

testFeature(manifestPayload, ["/proxy/route/command_pass"], "command_pass curl hands the request to curl", async () => {
  const res = await fetch("http://curl.test/via/curl?k=v", { proxy, method: "PUT", body: "data", headers: { "x-custom": "1" } });
  expect(res.status).toBe(200);
  expect(res.headers.get("x-upstream")).toBe("yes");
  expect(await res.json()).toEqual({
    method: "PUT",
    url: "/via/curl?k=v",
    host: "curl.test",
    body: "data",
  });
});

testFeature(
  `proxy {\n  route http://dead.test/* {\n    command_pass curl "--connect-to" "dead.test:80:127.0.0.1:1"\n  }\n}\n`,
  ["/proxy/route/command_pass"],
  "command_pass curl reports a bad gateway when curl fails",
  async (payload) => {
  const dead = join(mkdtempSync(join(tmpdir(), "donly-proxy-dead-")), "manifest.donly");
  writeFileSync(dead, payload);
  const deadConfig = await loadConfig(dead);
  const deadServer = createProxyServer(deadConfig);
  await new Promise<void>((resolve) => deadServer.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch("http://dead.test/", { proxy: `http://127.0.0.1:${(deadServer.address() as AddressInfo).port}` });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("curl exited with");
  } finally {
    deadServer.close();
  }
});

testFeature(`proxy {\n  route / {\n    command_pass wget\n  }\n}\n`, ["/proxy/route/command_pass"], "command_pass only supports known commands", async (payload) => {
  const bad = join(dir, "bad-command.donly");
  writeFileSync(bad, payload);
  expect(loadConfig(bad)).rejects.toThrow("solo soporta");
});
