import { afterAll, beforeAll, expect } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

// Plan: docs/plans/logger-transacciones.md. This spec declares the nested-transaction log of a
// `proxy_pass` route, and stays skipped until the Logger is wired to the server.
const dir = mkdtempSync(join(tmpdir(), "donly-proxy-logpp-"));
const logFile = join(dir, "proxy.ndjson");

const upstream = http.createServer(async (req, res) => {
  const body = Buffer.concat(await Array.fromAsync(req)).toString();
  res.setHeader("content-type", "text/plain");
  res.setHeader("x-upstream", "yes");
  res.end(`pong:${req.method}:${req.url}:${body}`);
});

const manifestPayload = (port: number) => `proxy {
  host "127.0.0.1"
  port 0
  log_file "./proxy.ndjson"
  route http://pass.test/ {
    proxy_pass "http://127.0.0.1:${port}"
  }
}
`;

const payload = manifestPayload(8080);
const saved = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
let server: ReturnType<typeof createProxyServer>;
let proxy: string;
let port: number;

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  port = (upstream.address() as AddressInfo).port;
  writeFileSync(join(dir, "manifest.donly"), manifestPayload(port));
  process.env.NO_PROXY = process.env.no_proxy = "";
  server = createProxyServer(await loadConfig(join(dir, "manifest.donly")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  for (const [key, value] of [["NO_PROXY", saved.NO_PROXY], ["no_proxy", saved.no_proxy]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  server.close();
  upstream.close();
});

testFeature(payload, ["/proxy/log_file", "/proxy/route/proxy_pass"], "logs request, request proxy_pass, response proxy_pass and response as nested transactions", async () => {
  const before = readFileSync(logFile, "utf8").split("\n").filter(Boolean).length;
  await (await fetch("http://pass.test/up?a=b", { proxy, method: "POST", body: "ping", headers: { "user-agent": "test", accept: "*/*", "accept-encoding": "identity" } })).text();
  const lines = readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(before).map((line) => JSON.parse(line));

  // The whole transaction, in order: request → request proxy_pass → response proxy_pass → response.
  expect(lines.map((line) => line.type)).toEqual(["request", "proxy_pass_request", "proxy_pass_response", "response"]);

  // The upstream pair is a child of the request and shares one span.
  const [request, proxyPassRequest, proxyPassResponse, response] = lines;
  expect(request.parent_span_id).toBeUndefined();
  expect(proxyPassRequest.parent_span_id).toBe(request.span_id);
  expect(proxyPassResponse.span_id).toBe(proxyPassRequest.span_id);
  expect(proxyPassResponse.parent_span_id).toBe(request.span_id);
  expect(response.span_id).toBe(request.span_id);
  expect(new Set(lines.map((line) => line.transaction_id)).size).toBe(1);

  // Mask what changes between runs: clocks, ids (kept distinguishable) and the port.
  const ids = new Map<string, string>();
  const id = (value: string | undefined, label: string) => {
    if (value === undefined) return undefined;
    if (!ids.has(value)) ids.set(value, `<${label}-${[...ids.values()].filter((v) => v.startsWith(`<${label}-`)).length + 1}>`);
    return ids.get(value);
  };
  const masked = lines.map((entry) => {
    entry.timestamp = "<timestamp>";
    expect(entry.performance_timestamp).toBeNumber();
    entry.performance_timestamp = "<performance_timestamp>";
    entry.transaction_id = id(entry.transaction_id, "transaction");
    entry.span_id = id(entry.span_id, "span");
    if (entry.parent_span_id) entry.parent_span_id = id(entry.parent_span_id, "span");
    if (entry.headers?.date) entry.headers.date = "<date>";
    return JSON.parse(JSON.stringify(entry).replaceAll(String(port), "<port>"));
  });
  expect(masked).toMatchSnapshot();
});
