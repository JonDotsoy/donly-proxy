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

/** The requests echo-pod logged, one JSON line each (echo-pod prints `JSON.stringify` per request). */
const echoLog = (): any[] =>
  sh(kubectl("logs", "echo-pod")).stdout.toString().split("\n").filter(Boolean).map((line) => JSON.parse(line));

cluster(manifestPayload, ["/proxy/route/kubectl_pass"], "echo-pod is not reachable directly but answers through kubectl_pass into conn-pod", async () => {
  // Precondition: nothing outside the cluster can reach echo-pod.
  await expect(fetch(`http://${HOST}/direct`, { proxy: "" })).rejects.toThrow();

  const before = readLog().length;
  const res = await fetch(`http://${HOST}/via-conn-pod?x=1`, { proxy, method: "POST", body: "payload", headers: { "x-custom": "abc" } });
  const text = await res.clone().text();
  expect(res.status, text).toBe(200);
  expect(res.headers.get("x-echo")).toBe("yes");
  expect(await res.json()).toMatchObject({ method: "POST", url: "/via-conn-pod?x=1", custom: "abc", body: "payload" });

  // The proxy log shows the request left through conn-pod.
  const [request, response] = readLog().slice(before);
  expect(request).toMatchObject({ type: "request", method: "POST", url: `http://${HOST}/via-conn-pod?x=1` });
  expect(response).toMatchObject({ type: "response", status: 200, transaction_id: request.transaction_id });
  expect(response.command.slice(0, 3)).toEqual(["kubectl", "exec", "-i"]);
  expect(response.command).toContain("conn-pod");
}, 60_000);

cluster(manifestPayload, ["/proxy/route/kubectl_pass"], "echo-pod logs every request it receives", async () => {
  await fetch(`http://${HOST}/log-get`, { proxy, headers: { "x-custom": "one" } });
  await fetch(`http://${HOST}/log-post`, { proxy, method: "POST", body: "two", headers: { "x-custom": "two" } });

  const logged = echoLog();
  expect(logged).toContainEqual(expect.objectContaining({ method: "GET", url: "/log-get", custom: "one", body: "" }));
  expect(logged).toContainEqual(expect.objectContaining({ method: "POST", url: "/log-post", custom: "two", body: "two" }));
}, 60_000);
