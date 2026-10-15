import { afterAll, beforeAll, expect } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

// Plan: docs/plans/logger-transacciones.md. This spec declares the nested-transaction log of a
// `kubectl_pass` route with the `node` engine, and stays skipped until the Logger lands.
const dir = mkdtempSync(join(tmpdir(), "donly-proxy-logtx-"));
const bin = join(dir, "bin");
const logFile = join(dir, "proxy.ndjson");

// Fake kubectl: runs what follows `--` locally, as `kubectl exec` would inside the container.
mkdirSync(bin);
writeFileSync(join(bin, "kubectl"), `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`);
chmodSync(join(bin, "kubectl"), 0o755);

const upstream = http.createServer((_req, res) => {
  res.setHeader("content-type", "text/plain");
  res.end("pong");
});

const manifestPayload = (port: number) => `proxy {
  host "127.0.0.1"
  port 0
  log_file "./proxy.ndjson"
  route http://127.0.0.1:${port}/ {
    kubectl_pass "pod/api-0" {
      command_pass node
    }
  }
}
`;

const payload = manifestPayload(8080);
const saved = { PATH: process.env.PATH, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
let server: ReturnType<typeof createProxyServer>;
let proxy: string;
let port: number;

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  port = (upstream.address() as AddressInfo).port;
  writeFileSync(join(dir, "manifest.donly"), manifestPayload(port));
  process.env.NO_PROXY = process.env.no_proxy = "";
  process.env.PATH = `${bin}${delimiter}${saved.PATH}`;
  server = createProxyServer(await loadConfig(join(dir, "manifest.donly")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  process.env.PATH = saved.PATH;
  for (const [key, value] of [["NO_PROXY", saved.NO_PROXY], ["no_proxy", saved.no_proxy]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  server.close();
  upstream.close();
});

testFeature(payload, ["/proxy/log_file", "/proxy/route/kubectl_pass/command_pass"], "logs request, kubectl, node, end node, end kubectl and response as nested transactions", async () => {
  const before = readFileSync(logFile, "utf8").split("\n").filter(Boolean).length;
  // Fixed client headers: the default ones carry the version of the runtime.
  await (await fetch(`http://127.0.0.1:${port}/ping?x=1`, { proxy, headers: { "user-agent": "test", accept: "*/*", "accept-encoding": "identity" } })).text();
  const lines = readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(before).map((line) => JSON.parse(line));

  // The whole transaction, in order: request → kubectl → node → script → end node → end kubectl → response.
  const kinds = lines.map((line) => (line.type === "command_start" || line.type === "command_end" ? `${line.type}:${line.program}` : line.type));
  expect(kinds).toEqual(["request", "command_start:kubectl", "command_start:node", "script_start", "command_end:node", "script_end", "command_end:kubectl", "response"]);

  // Parent/child links: request ← kubectl ← node ← script, and every end shares the span of its command.
  const [request, kubectl, node, script, nodeEnd, , kubectlEnd, response] = lines;
  expect(request.parent_span_id).toBeUndefined();
  expect(kubectl.parent_span_id).toBe(request.span_id);
  expect(node.parent_span_id).toBe(kubectl.span_id);
  expect(script.parent_span_id).toBe(node.span_id);
  expect(nodeEnd.span_id).toBe(node.span_id);
  expect(kubectlEnd.span_id).toBe(kubectl.span_id);
  expect(response.span_id).toBe(request.span_id);
  expect(new Set(lines.map((line) => line.transaction_id)).size).toBe(1);

  // Mask what changes between runs: clocks (`timestamp` and `performance_timestamp`), ids (kept distinguishable), the port and the script body.
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
    if (entry.script) entry.script = "<script>";
    if (entry.console_log) {
      entry.console_log = entry.console_log.map((log: { type: string; timestamp: string; message: string }) => ({
        ...log,
        timestamp: "<timestamp>",
        message: log.type === "stdin" ? "<script>" : log.message.replace(/"date":"[^"]*"/, '"date":"<date>"'),
      }));
    }
    return JSON.parse(JSON.stringify(entry).replaceAll(String(port), "<port>"));
  });
  expect(masked).toMatchSnapshot();
});
