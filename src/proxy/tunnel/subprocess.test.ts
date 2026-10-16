import { afterAll, beforeAll, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ShellRequest, SystemSpawn, spawn } from "../../spawn";
import { curl } from "./curl/curl";
import { kubectlRequest } from "./kubectl/kubectl";
import { nodeRequest } from "./node/node";
import { run } from "./run";
import { sshRequest } from "./ssh/ssh";
import type { CurlRequest } from "./types";

// The tunnels (curl, node, ssh, kubectl) running inside a shell that is already running (`SystemSpawn.fromResponse`).
const dir = mkdtempSync(join(tmpdir(), "donly-proxy-subprocess-"));
const bin = join(dir, "bin");
mkdirSync(bin);
// Fake `ssh` / `kubectl`: run the remote command locally, as the remote side would.
writeFileSync(join(bin, "ssh"), `#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n`);
writeFileSync(
  join(bin, "kubectl"),
  `#!/bin/sh
if [ "$1" = "get" ]; then printf 'pod/other-1\\npod/my-pod-1\\n'; exit 0; fi
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
);
chmodSync(join(bin, "ssh"), 0o755);
chmodSync(join(bin, "kubectl"), 0o755);

const upstream = http.createServer(async (req, res) => {
  const body = Buffer.concat(await Array.fromAsync(req)).toString();
  res.setHeader("x-upstream", "yes");
  res.end(JSON.stringify({ method: req.method, url: req.url, body }));
});

const saved = { PATH: process.env.PATH, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
let port: number;
const bashRequest = () => new ShellRequest({ commands: ["bash"], stdin: new WritableStream() });

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  port = (upstream.address() as AddressInfo).port;
  process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost";
  process.env.PATH = `${bin}${delimiter}${saved.PATH}`;
});

afterAll(() => {
  process.env.PATH = saved.PATH;
  for (const [key, value] of [["NO_PROXY", saved.NO_PROXY], ["no_proxy", saved.no_proxy]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  upstream.close();
});

/** Runs `fn` with a `system` backed by a bash, and closes the bash through its stdin afterwards. */
const inBash = async (fn: (system: SystemSpawn) => Promise<void>) => {
  const request = bashRequest();
  const bash = await spawn(request);
  try {
    await fn(SystemSpawn.fromResponse(bash));
  } finally {
    await request.stdin!.getWriter().close();
  }
  expect(await bash.exitCode).toBe(0);
};

const request = (path: string, extra: Partial<CurlRequest> = {}): CurlRequest => ({
  method: "POST",
  url: `http://127.0.0.1:${port}${path}`,
  headers: { "x-custom": "1" },
  body: Buffer.from("hello body"),
  args: [],
  ...extra,
});

const expectEcho = (response: { status: number; headers: Record<string, unknown>; body: Buffer }, path: string) => {
  expect(response.status).toBe(200);
  expect(response.headers["x-upstream"]).toBe("yes");
  expect(JSON.parse(response.body.toString())).toEqual({ method: "POST", url: path, body: "hello body" });
};

test("run() separates stdout, stderr and exit code of a command inside a running bash, and feeds its stdin", async () => {
  await inBash(async (system) => {
    const result = await run("sh", ["-c", "cat; echo err >&2; exit 3"], "from stdin", undefined, { A: "1" }, undefined, undefined, system);
    expect(result.stdout.toString()).toBe("from stdin");
    expect(result.stderr.toString()).toBe("err\n");
    expect(result.code).toBe(3);
  });
});

test("command_pass curl runs inside a running bash", async () => {
  await inBash(async (system) => expectEcho(await curl(request("/curl", { system })), "/curl"));
});

test("command_pass node runs inside a running bash", async () => {
  await inBash(async (system) => expectEcho(await nodeRequest(request("/node", { system })), "/node"));
});

test("ssh_pass runs inside a running bash with the curl, node and wget engines", async () => {
  await inBash(async (system) => {
    expectEcho(await sshRequest(request("/ssh-curl", { args: ["user@remote.test"], system }), "curl"), "/ssh-curl");
    expectEcho(await sshRequest(request("/ssh-node", { args: ["user@remote.test"], system }), "node"), "/ssh-node");
    const wget = await sshRequest(request("/ssh-wget", { args: ["user@remote.test"], system }), "wget");
    expect(wget.status).toBe(200);
  });
});

test("kubectl_pass runs inside a running bash, including the pod_match lookup", async () => {
  await inBash(async (system) => {
    expectEcho(await kubectlRequest(request("/kubectl", { args: ["pod/api-0"], system }), "curl"), "/kubectl");
    const matched = request("/pod-match", { podMatch: { glob: "my-pod-*", selectors: [] }, system });
    expectEcho(await kubectlRequest(matched, "node"), "/pod-match");
  });
});

test("an unknown program inside a running bash ends with exit code 127 and the shell keeps working", async () => {
  await inBash(async (system) => {
    const missing = await run("donly-no-such-program", [], "", undefined, undefined, undefined, undefined, system);
    expect(missing.code).toBe(127);
    expect((await run("echo", ["still alive"], "", undefined, undefined, undefined, undefined, system)).stdout.toString()).toBe("still alive\n");
  });
});

test("a large body travels through a running bash intact", async () => {
  await inBash(async (system) => {
    const body = Buffer.alloc(300_000, "abcdefghij");
    const response = await curl(request("/large", { body, system }));
    expect(JSON.parse(response.body.toString()).body).toBe(body.toString());
  });
});
