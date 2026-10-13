import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type http from "node:http";
import { createProxyServer, loadConfig } from "./server";

// End to end against a real cluster: podman builds an echo server image, it is loaded into
// the kind node and deployed as a Service, and `command_pass kubectl` reaches that Service
// from inside a pod. The cluster must be exactly `kind-kind-cluster`; without podman, kubectl
// or that cluster the tests are skipped.
const CONTEXT = "kind-kind-cluster";
const NODE_CONTAINER = "kind-cluster-control-plane";
const NAMESPACE = "donly-proxy-test";
const ENGINES = ["curl", "wget", "node"] as const;
const IMAGE = "localhost/donly-proxy-echo:test";

const sh = (cmd: string[], input?: Uint8Array) => Bun.spawnSync(cmd, { stdin: input, stdout: "pipe", stderr: "pipe" });
const ok = (cmd: string[]) => {
  try {
    return sh(cmd).exitCode === 0;
  } catch {
    return false;
  }
};
const must = (cmd: string[], input?: Uint8Array) => {
  const result = sh(cmd, input);
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout;
};

const available =
  ok(["podman", "version"]) &&
  ok(["kubectl", "--context", CONTEXT, "get", "nodes"]) &&
  ok(["podman", "container", "exists", NODE_CONTAINER]);
const cluster = available ? test : test.skip;

const echoServer = `
import http from "node:http";
http.createServer(async (req, res) => {
  const body = Buffer.concat(await Array.fromAsync(req)).toString();
  res.setHeader("x-echo", "yes");
  res.end(JSON.stringify({ method: req.method, url: req.url, custom: req.headers["x-custom"], body }));
}).listen(8080);
`;

const kubectl = (...args: string[]) => must(["kubectl", "--context", CONTEXT, ...args]);

let server: http.Server;
let logFile: string;
let proxy: string;
const saved = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };

beforeAll(async () => {
  if (!available) return;
  const dir = mkdtempSync(join(tmpdir(), "donly-proxy-kind-"));

  // 1. podman builds the echo server image and imports it into the kind node (containerd).
  writeFileSync(join(dir, "echo.mjs"), echoServer);
  writeFileSync(join(dir, "Containerfile"), 'FROM docker.io/library/node:alpine\nRUN apk add --no-cache curl\nCOPY echo.mjs /echo.mjs\nCMD ["node", "/echo.mjs"]\n');
  must(["podman", "build", "-t", IMAGE, dir]);
  const archive = join(dir, "echo.tar");
  must(["podman", "save", "--format", "docker-archive", "-o", archive, IMAGE]);
  must(["podman", "exec", "-i", NODE_CONTAINER, "ctr", "-n", "k8s.io", "images", "import", "-"], await Bun.file(archive).bytes());

  // 2. The Service in the cluster.
  const manifestYaml = `
apiVersion: v1
kind: Namespace
metadata: { name: ${NAMESPACE} }
---
apiVersion: v1
kind: Pod
metadata: { name: echo, namespace: ${NAMESPACE}, labels: { app: echo } }
spec:
  containers:
    - name: echo
      image: ${IMAGE}
      imagePullPolicy: Never
      ports: [{ containerPort: 8080 }]
---
apiVersion: v1
kind: Service
metadata: { name: echo, namespace: ${NAMESPACE} }
spec:
  selector: { app: echo }
  ports: [{ port: 80, targetPort: 8080 }]
`;
  must(["kubectl", "--context", CONTEXT, "delete", "namespace", NAMESPACE, "--ignore-not-found", "--wait=true"]);
  must(["kubectl", "--context", CONTEXT, "apply", "-f", "-"], new TextEncoder().encode(manifestYaml));
  kubectl("-n", NAMESPACE, "wait", "--for=condition=Ready", "pod/echo", "--timeout=120s");

  // kube-proxy programs the Service a moment after the pod is Ready: wait until it answers.
  const probe = ["kubectl", "--context", CONTEXT, "-n", NAMESPACE, "exec", "echo", "--", "node", "-e", `fetch("http://echo.${NAMESPACE}.svc.cluster.local/").then(() => {}, () => process.exit(1))`];
  for (let attempt = 0; sh(probe).exitCode !== 0; attempt++) {
    if (attempt >= 60) throw new Error("the echo Service never became reachable");
    await Bun.sleep(1000);
  }

  // 3. The proxy, whose routes run the request inside the echo pod.
  writeFileSync(
    join(dir, "manifest.donly"),
    `proxy {
  host "127.0.0.1"
  port 0
  log_file "./proxy.ndjson"
${ENGINES.map(
    (engine) =>
      engine === "node"
        ? `  route http://echo.${NAMESPACE}.svc.cluster.local/node/ {
    command_pass kubectl "--context" "${CONTEXT}" "-n" "${NAMESPACE}" "pod/echo" {
      engine node
    }
  }
`
        : `  route http://echo.${NAMESPACE}.svc.cluster.local/${engine}/ {
    kubectl_pass "--context" "${CONTEXT}" "-n" "${NAMESPACE}" "pod/echo" {
      command_pass ${engine}
    }
  }
`,
  ).join("")}}
`,
  );
  logFile = join(dir, "proxy.ndjson");
  process.env.NO_PROXY = process.env.no_proxy = "";
  server = createProxyServer(await loadConfig(join(dir, "manifest.donly")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 300_000);

afterAll(() => {
  if (!available) return;
  server?.close();
  for (const [key, value] of [["NO_PROXY", saved.NO_PROXY], ["no_proxy", saved.no_proxy]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  sh(["kubectl", "--context", CONTEXT, "delete", "namespace", NAMESPACE, "--ignore-not-found", "--wait=false"]);
});

const readLog = (): any[] =>
  existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

for (const engine of ENGINES) {
  cluster(`[command_pass.kubectl.kind] command_pass kubectl with engine ${engine} reaches an echo Service in the kind-kind-cluster`, async () => {
    const url = `http://echo.${NAMESPACE}.svc.cluster.local/${engine}/path?x=1`;
    const before = readLog().length;
    const res = await fetch(url, { proxy, method: "POST", body: "payload", headers: { "x-custom": "abc" } });
    const text = await res.clone().text();
    expect(res.status, text).toBe(200);
    expect(res.headers.get("x-echo")).toBe("yes");
    expect(await res.json()).toEqual({ method: "POST", url: `/${engine}/path?x=1`, custom: "abc", body: "payload" });

    // The log holds both the request and the command_pass that carried it to the pod.
    const [request, response, ...rest] = readLog().slice(before);
    expect(rest).toEqual([]);
    expect(request).toMatchObject({ type: "request", method: "POST", url, headers: { "x-custom": "abc" }, payload: "payload" });
    expect(response).toMatchObject({ type: "response", status: 200, transaction_id: request.transaction_id });
    expect(response.headers["x-echo"]).toBe("yes");
    expect(JSON.parse(response.payload)).toMatchObject({ method: "POST", url: `/${engine}/path?x=1`, body: "payload" });
    expect(response.command.slice(0, 3)).toEqual(["kubectl", "exec", "-i"]);
    expect(response.command).toContain(CONTEXT);
    expect(response.command).toContain("pod/echo");
    expect(response.command).toContain("--");
    expect(response.command.join(" ")).toContain(engine === "node" ? "node --input-type=module -" : `${engine} `);
  }, 60_000);
}

cluster("[command_pass.kubectl.kind] wget answers GET requests and reports the status of failed ones", async () => {
  const get = await fetch(`http://echo.${NAMESPACE}.svc.cluster.local/wget/get`, { proxy });
  expect(get.status).toBe(200);
  expect((await get.json()).method).toBe("GET");
  const put = await fetch(`http://echo.${NAMESPACE}.svc.cluster.local/wget/put`, { proxy, method: "PUT", body: "x" });
  expect(put.status).toBe(502);
  expect(await put.text()).toContain("wget only supports GET and POST");
}, 60_000);
