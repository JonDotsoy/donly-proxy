import { afterAll, beforeAll, expect } from "bun:test";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type http from "node:http";
import { createProxyServer, loadConfig } from "../../server";
import { testFeature } from "../../../utils/test_utils/test-feature/test-feature";

// End to end against a real cluster: podman builds an echo server image, it is loaded into
// the kind node and deployed as a Service, and `kubectl_pass` / `command_pass kubectl` reach
// that Service from inside a pod. The cluster must be exactly `kind-kind-cluster`; without
// podman, kubectl or that cluster the tests are skipped.
export const CONTEXT = "kind-kind-cluster";
const NODE_CONTAINER = "kind-cluster-control-plane";
export const NAMESPACE = "donly-proxy-test";
export const IMAGE = "localhost/donly-proxy-echo:test";
const HOST = `echo.${NAMESPACE}.svc.cluster.local`;

export type KindEngine = "curl" | "wget" | "node";

export const sh = (cmd: string[], input?: Uint8Array) => Bun.spawnSync(cmd, { stdin: input, stdout: "pipe", stderr: "pipe" });
const ok = (cmd: string[]) => {
  try {
    return sh(cmd).exitCode === 0;
  } catch {
    return false;
  }
};
export const must = (cmd: string[], input?: Uint8Array) => {
  const result = sh(cmd, input);
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout;
};

export const available =
  ok(["podman", "version"]) &&
  ok(["kubectl", "--context", CONTEXT, "get", "nodes"]) &&
  ok(["podman", "container", "exists", NODE_CONTAINER]);
export const cluster = available ? testFeature : testFeature.skip;

const echoServer = `
import http from "node:http";
http.createServer(async (req, res) => {
  const body = Buffer.concat(await Array.fromAsync(req)).toString();
  res.setHeader("x-echo", "yes");
  res.end(JSON.stringify({ method: req.method, url: req.url, custom: req.headers["x-custom"], body }));
}).listen(8080);
`;

/** Builds the echo image (node + curl) and imports it into the kind node (containerd). Runs once per test run. */
export const loadImage = async () => {
  const dir = mkdtempSync(join(tmpdir(), "donly-proxy-kind-"));
  writeFileSync(join(dir, "echo.mjs"), echoServer);
  writeFileSync(join(dir, "Containerfile"), 'FROM docker.io/library/node:alpine\nRUN apk add --no-cache curl\nCOPY echo.mjs /echo.mjs\nCMD ["node", "/echo.mjs"]\n');
  must(["podman", "build", "-t", IMAGE, dir]);
  const archive = join(dir, "echo.tar");
  must(["podman", "save", "--format", "docker-archive", "-o", archive, IMAGE]);
  must(["podman", "exec", "-i", NODE_CONTAINER, "ctr", "-n", "k8s.io", "images", "import", "-"], await Bun.file(archive).bytes());
};

const imageLoaded = globalThis as { __donlyKindImage?: Promise<void> };
export const ensureImage = () => (imageLoaded.__donlyKindImage ??= loadImage());

/** Builds the echo image, imports it into the kind node and deploys it. Shared by every test file. */
const deploy = async () => {
  // 1. podman builds the echo server image and imports it into the kind node (containerd).
  await ensureImage();

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
  must(["kubectl", "--context", CONTEXT, "-n", NAMESPACE, "wait", "--for=condition=Ready", "pod/echo", "--timeout=120s"]);

  // kube-proxy programs the Service a moment after the pod is Ready: wait until it answers.
  const probe = ["kubectl", "--context", CONTEXT, "-n", NAMESPACE, "exec", "echo", "--", "node", "-e", `fetch("http://${HOST}/").then(() => {}, () => process.exit(1))`];
  for (let attempt = 0; sh(probe).exitCode !== 0; attempt++) {
    if (attempt >= 60) throw new Error("the echo Service never became reachable");
    await Bun.sleep(1000);
  }
  process.on("exit", () => {
    sh(["kubectl", "--context", CONTEXT, "delete", "namespace", NAMESPACE, "--ignore-not-found", "--wait=false"]);
  });
};

const deployed = globalThis as { __donlyKindDeployed?: Promise<void> };

/** The manifest route that sends `/<engine>/` through the echo pod. */
const route = (engine: KindEngine) =>
  engine === "node"
    ? `  route http://${HOST}/node/ {
    command_pass kubectl "--context" "${CONTEXT}" "-n" "${NAMESPACE}" "pod/echo" {
      engine node
    }
  }
`
    : `  route http://${HOST}/${engine}/ {
    kubectl_pass "--context" "${CONTEXT}" "-n" "${NAMESPACE}" "pod/echo" {
      command_pass ${engine}
    }
  }
`;

/** The manifest of the proxy that carries the requests of `engine` to the echo pod. */
export const manifestFor = (engine: KindEngine) =>
  `proxy {\n  host "127.0.0.1"\n  port 0\n  log_file "./proxy.ndjson"\n${route(engine)}}\n`;

/** The manifest of a proxy that sends httpbin.io/get (http and https) through `kubectl_pass` + curl in the echo pod.
 * The pod resolves DNS and reaches the internet, which can fail at first: curl retries (even resolve errors). */
export const httpbinManifest = `proxy {
  host "127.0.0.1"
  port 0
  log_file "./proxy.ndjson"
  route https?://httpbin.io/get {
    kubectl_pass "--context" "${CONTEXT}" "-n" "${NAMESPACE}" "pod/echo" {
      command_pass curl {
        retry 3
        extra_args --retry-all-errors --retry-delay 2
      }
    }
  }
}
`;

/**
 * Deploys the echo Service (once) and starts a proxy with a route for `engine` (or with `manifest`).
 * Call it at the top level of a test file.
 */
export const useKind = (engine: KindEngine, manifest = manifestFor(engine)) => {
  let server: ReturnType<typeof createProxyServer>;
  let logFile: string;
  let proxy: string;
  const saved = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };

  beforeAll(async () => {
    if (!available) return;
    await (deployed.__donlyKindDeployed ??= deploy());
    const dir = mkdtempSync(join(tmpdir(), "donly-proxy-kind-proxy-"));
    writeFileSync(join(dir, "manifest.donly"), manifest);
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
  });

  const readLog = (): any[] =>
    existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

  return {
    url: (path: string) => `http://${HOST}/${engine}/${path}`,
    proxy: () => proxy,
    readLog,
  };
};

/** The shared check: a POST through the proxy reaches the echo pod and both log lines are written. */
export const echoTest = (engine: KindEngine, kind: ReturnType<typeof useKind>) =>
  cluster(manifestFor(engine), ["/proxy/route/kubectl_pass"], `command_pass kubectl with engine ${engine} reaches an echo Service in the kind-kind-cluster`, async () => {
    const url = kind.url("path?x=1");
    const before = kind.readLog().length;
    const res = await fetch(url, { proxy: kind.proxy(), method: "POST", body: "payload", headers: { "x-custom": "abc" } });
    const text = await res.clone().text();
    expect(res.status, text).toBe(200);
    expect(res.headers.get("x-echo")).toBe("yes");
    expect(await res.json()).toEqual({ method: "POST", url: `/${engine}/path?x=1`, custom: "abc", body: "payload" });

    // The log holds the request, the commands that carried it to the pod (and their script, for node) and the response.
    const entries = kind.readLog().slice(before);
    const request = entries.find((entry) => entry.type === "request");
    const response = entries.find((entry) => entry.type === "response");
    expect(entries.map((entry) => entry.type)).toEqual(
      engine === "node"
        ? ["request", "command_start", "command_start", "script_start", "command_end", "script_end", "command_end", "response"]
        : ["request", "command_start", "command_start", "command_end", "command_end", "response"],
    );
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
