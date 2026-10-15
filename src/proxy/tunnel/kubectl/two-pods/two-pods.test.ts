import { afterAll, beforeAll, expect } from "bun:test";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "../../../server";
import { available, cluster, CONTEXT, ensureImage, IMAGE, must, sh } from "../kind-fixture";

// Two pods in the kind-kind-cluster: `conn-pod` (the one `kubectl_pass` execs into) and `echo-pod`
// (receives the request and logs everything it gets). echo-pod only has a ClusterIP Service: it is
// not reachable from outside the cluster, only from inside it (from conn-pod).
const NAMESPACE = "donly-proxy-two-pods";
const HOST = `echo-pod.${NAMESPACE}.svc.cluster.local`;
const podsFile = join(import.meta.dir, "pods.yaml");

const kubectl = (...args: string[]) => ["kubectl", "--context", CONTEXT, "-n", NAMESPACE, ...args];

const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  log_file "./proxy.ndjson"
  route {
    kubectl_pass "conn-pod" {
      context ${CONTEXT}
      namespace ${NAMESPACE}
      command_pass node
    }
  }
}
`;

let server: http.Server;
let proxy: string;
let logFile: string;
const saved = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };

beforeAll(async () => {
  if (!available) return;
  await ensureImage();
  must(["kubectl", "--context", CONTEXT, "delete", "namespace", NAMESPACE, "--ignore-not-found", "--wait=true"]);
  must(["kubectl", "--context", CONTEXT, "apply", "-f", podsFile]);
  must(kubectl("wait", "--for=condition=Ready", "pod/conn-pod", "pod/echo-pod", "--timeout=120s"));

  // kube-proxy programs the Service a moment after the pod is Ready: wait until conn-pod reaches it.
  const probe = kubectl("exec", "conn-pod", "--", "node", "-e", `fetch("http://${HOST}/").then(() => {}, () => process.exit(1))`);
  for (let attempt = 0; sh(probe).exitCode !== 0; attempt++) {
    if (attempt >= 60) throw new Error("echo-pod never became reachable from conn-pod");
    await Bun.sleep(1000);
  }

  const dir = mkdtempSync(join(tmpdir(), "donly-proxy-two-pods-"));
  writeFileSync(join(dir, "manifest.donly"), manifestPayload);
  logFile = join(dir, "proxy.ndjson");
  process.env.NO_PROXY = process.env.no_proxy = "";
  server = createProxyServer(await loadConfig(join(dir, "manifest.donly")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 300_000);

afterAll(() => {
  if (!available) return;
  server?.close();
  sh(["kubectl", "--context", CONTEXT, "delete", "namespace", NAMESPACE, "--ignore-not-found", "--wait=false"]);
  for (const [key, value] of [["NO_PROXY", saved.NO_PROXY], ["no_proxy", saved.no_proxy]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const readLog = (): any[] =>
  existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

// Fixed client headers so the snapshots do not depend on the Bun version.
const base = { "user-agent": "test", accept: "*/*", "accept-encoding": "identity" };

/** Masks what changes between runs: timestamps, transaction ids, the date header and the (long) node script. */
const mask = (entries: any[]) => {
  const ids = new Map<string, string>();
  return entries.map((entry) => {
    if (!ids.has(entry.transaction_id)) ids.set(entry.transaction_id, `<transaction-${ids.size + 1}>`);
    return { ...entry, timestamp: "<timestamp>", performance_timestamp: "<performance>", ...(entry.script && { script: "<script>" }), transaction_id: ids.get(entry.transaction_id), ...(entry.headers && { headers: { ...entry.headers, ...(entry.headers.date && { date: "<date>" }) } }) };
  });
};

/** The requests echo-pod logged, one JSON line each (echo-pod prints `JSON.stringify` per request). */
const echoLog = (): any[] =>
  sh(kubectl("logs", "echo-pod")).stdout.toString().split("\n").filter(Boolean).map((line) => JSON.parse(line));

cluster(manifestPayload, ["/proxy/route/kubectl_pass"], "echo-pod is not reachable directly but answers through kubectl_pass into conn-pod", async () => {
  // Precondition: nothing outside the cluster can reach echo-pod.
  await expect(fetch(`http://${HOST}/direct`, { proxy: "" })).rejects.toThrow();

  const before = readLog().length;
  const res = await fetch(`http://${HOST}/via-conn-pod?x=1`, { proxy, method: "POST", body: "payload", headers: { ...base, "x-custom": "abc" } });
  const text = await res.clone().text();
  expect(res.status, text).toBe(200);
  expect(res.headers.get("x-echo")).toBe("yes");
  expect(await res.json()).toMatchObject({ method: "POST", url: "/via-conn-pod?x=1", custom: "abc", body: "payload" });

  // The proxy log of the transaction: request, kubectl, node, the node script, node exit, kubectl end and response, in that order.
  const entries = readLog().slice(before);
  expect(entries.map((entry) => [entry.type, entry.program])).toEqual([
    ["request", undefined],
    ["command_start", "kubectl"],
    ["command_start", "node"],
    ["script_start", "node"],
    ["command_end", "node"],
    ["script_end", "node"],
    ["command_end", "kubectl"],
    ["response", undefined],
  ]);
  const [request, kubectlStart, nodeStart, script, nodeExit, , kubectlExit, response] = entries;
  expect(request).toMatchObject({ method: "POST", url: `http://${HOST}/via-conn-pod?x=1` });
  expect(kubectlStart.command).toEqual(["kubectl", "exec", "-i", "-q", "--context", CONTEXT, "--namespace", NAMESPACE, "conn-pod", "--", "node", "--input-type=module", "-"]);
  expect(nodeStart.command).toEqual(["node", "--input-type=module", "-"]);
  // The script node reads from stdin: the request prelude and the code that performs it.
  expect(script.script).toContain("globalThis.__donlyRequest");
  expect(script.script).toContain("http");
  expect(nodeExit.exit_code).toBe(0);
  expect(kubectlExit.exit_code).toBe(0);
  expect(response).toMatchObject({ status: 200 });
  expect(response.command.slice(0, 3)).toEqual(["kubectl", "exec", "-i"]);

  // Every entry shares the transaction id and carries a ms timestamp plus a Performance API one.
  for (const entry of entries) {
    expect(entry.transaction_id).toBe(request.transaction_id);
    expect(entry.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(entry.performance_timestamp).toBeTypeOf("number");
  }
  const times = entries.map((entry) => entry.performance_timestamp);
  expect(times).toEqual([...times].sort((x, y) => x - y));
  expect(mask(readLog().slice(before))).toMatchSnapshot();
}, 60_000);

cluster(manifestPayload, ["/proxy/route/kubectl_pass"], "echo-pod logs every request it receives", async () => {
  await fetch(`http://${HOST}/log-get`, { proxy, headers: { ...base, "x-custom": "one" } });
  await fetch(`http://${HOST}/log-post`, { proxy, method: "POST", body: "two", headers: { ...base, "x-custom": "two" } });

  const logged = echoLog();
  expect(logged.filter((entry) => entry.url.startsWith("/log-"))).toMatchSnapshot();
  expect(logged).toContainEqual(expect.objectContaining({ method: "GET", url: "/log-get", custom: "one", body: "" }));
  expect(logged).toContainEqual(expect.objectContaining({ method: "POST", url: "/log-post", custom: "two", body: "two" }));
}, 60_000);
