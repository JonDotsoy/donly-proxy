import { afterAll, beforeAll, expect } from "bun:test";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-logspawn-"));
const bin = join(dir, "bin");
const logFile = join(dir, "proxy.ndjson");

// Dummy kubectl and ssh: they answer like the curl engine does (body on stdout, status and headers on stderr).
// kubectl also lists a pod for `get pods` and fails when the target is `deploy/broken`.
mkdirSync(bin);
const reply = (name: string) => `cat > /dev/null\nprintf '200\\n{"content-type":["text/plain"]}' >&2\nprintf 'from ${name}'\n`;
writeFileSync(join(bin, "kubectl"), `#!/bin/sh\nif [ "$1" = get ]; then echo pod/api-0; exit 0; fi\ncase " $* " in *deploy/broken*) cat > /dev/null; echo "boom" >&2; exit 3;; esac\n${reply("kubectl")}`);
writeFileSync(join(bin, "ssh"), `#!/bin/sh\n${reply("ssh")}`);
for (const name of ["kubectl", "ssh"]) chmodSync(join(bin, name), 0o755);

const payload = `proxy {
  host "127.0.0.1"
  port 0
  log_file "./proxy.ndjson"
  route http://spawnlog.test/kubectl {
    command_pass kubectl "-n" "prod" "deploy/api"
  }
  route http://spawnlog.test/broken {
    command_pass kubectl "deploy/broken"
  }
  route http://spawnlog.test/pod-match {
    kubectl_pass "-n" "prod" {
      pod_match "api-*"
      command_pass curl
    }
  }
  route http://spawnlog.test/ssh {
    command_pass ssh "-p" "2222" "user@remote.test"
  }
}
`;

const saved = { PATH: process.env.PATH, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
let server: ReturnType<typeof createProxyServer>;
let proxy: string;

beforeAll(async () => {
  writeFileSync(join(dir, "manifest.donly"), payload);
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
});

const readLog = (): any[] => {
  try {
    return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

/** Requests `url` and returns the lines of the log it produced, in order. */
const lines = async (url: string) => {
  const before = readLog().length;
  // Fixed user-agent: the runtime version must not leak into the snapshots.
  const res = await fetch(url, { proxy, headers: { "user-agent": "donly-test" } });
  await res.text();
  return { status: res.status, entries: readLog().slice(before) };
};

const spawnTypes = ["command_start", "command_end"];
const features = ["/proxy/log_file", "/proxy/route/command_pass"];

testFeature(payload, features, "should write a command_start and a command_end line for the ssh ShellRequest", async () => {
  const { status, entries } = await lines("http://spawnlog.test/ssh");
  expect(status).toBe(200);
  const spawned = entries.filter((e) => spawnTypes.includes(e.type));
  expect(spawned.map((e) => e.type)).toEqual(["command_start", "command_end"]);
  const [start, end] = spawned;
  const request = entries.find((e) => e.type === "request");
  expect(start).toMatchObject({ program: "ssh", parent_span_id: request.span_id });
  expect(start.args.slice(0, 2)).toEqual(["-p", "2222"]);
  expect(end).toMatchObject({ span_id: start.span_id, program: "ssh", exit_code: 0 });
  expect(end.console_log.map((c: any) => c.type)).toContain("stdin");
  expect(end.console_log.find((c: any) => c.type === "stdout").message).toBe("from ssh");
  expect(end.console_log.find((c: any) => c.type === "stderr").message).toContain("200");
  // Order of a transaction: request, the process, response.
  expect(entries.map((e) => e.type)).toEqual(["request", "command_start", "command_end", "response"]);
});

testFeature(payload, features, "should write two nested command lines for the kubectl ShellRequest", async () => {
  const { entries } = await lines("http://spawnlog.test/kubectl");
  expect(entries.map((e) => `${e.type}${e.program ? `:${e.program}` : ""}`)).toEqual([
    "request", "command_start:kubectl", "command_start:sh", "command_end:sh", "command_end:kubectl", "response",
  ]);
  const [, kubectl, engine, engineEnd, kubectlEnd] = entries;
  expect(kubectl.args.slice(0, 3)).toEqual(["exec", "-i", "-q"]);
  expect(engine.parent_span_id).toBe(kubectl.span_id);
  expect(engineEnd).toMatchObject({ span_id: engine.span_id, exit_code: 0 });
  expect(kubectlEnd).toMatchObject({ span_id: kubectl.span_id, exit_code: 0 });
  expect(kubectlEnd.console_log).toEqual(engineEnd.console_log);
  expect(kubectlEnd.console_log.find((c: any) => c.type === "stdout").message).toBe("from kubectl");
});

testFeature(payload, features, "should close the kubectl command lines with its exit code and stderr when it fails", async () => {
  const { status, entries } = await lines("http://spawnlog.test/broken");
  expect(status).toBe(502);
  const ends = entries.filter((e) => e.type === "command_end");
  expect(ends).toHaveLength(2);
  for (const end of ends) {
    expect(end.exit_code).toBe(3);
    expect(end.console_log.find((c: any) => c.type === "stderr").message).toBe("boom\n");
  }
});

testFeature(payload, ["/proxy/log_file", "/proxy/route/kubectl_pass/pod_match"], "should write the kubectl get pods lookup as its own command lines, a sibling of the exec", async () => {
  const { entries } = await lines("http://spawnlog.test/pod-match");
  const starts = entries.filter((e) => e.type === "command_start");
  expect(starts.map((e) => e.args[0])).toEqual(["get", "exec", expect.any(String)]);
  const [lookup, exec] = starts;
  expect(lookup.parent_span_id).toBe(exec.parent_span_id);
  const lookupEnd = entries.find((e) => e.type === "command_end" && e.span_id === lookup.span_id);
  expect(lookupEnd).toMatchObject({ exit_code: 0 });
  expect(lookupEnd.console_log.find((c: any) => c.type === "stdout").message).toBe("pod/api-0\n");
});

/** Replaces ids, moments and the proxy port so a transaction can be compared with its snapshot. */
const mask = (entries: any[]) => {
  const ids = new Map<string, string>();
  const id = (value: string, kind: string) => {
    if (!ids.has(value)) ids.set(value, `<${kind}-${ids.size + 1}>`);
    return ids.get(value)!;
  };
  const port = new URL(proxy).port;
  return entries.map((entry) => {
    entry = structuredClone(entry);
    entry.timestamp = "<timestamp>";
    entry.performance_timestamp = "<performance_timestamp>";
    entry.transaction_id = id(entry.transaction_id, "transaction");
    entry.span_id = id(entry.span_id, "span");
    if (entry.parent_span_id) entry.parent_span_id = id(entry.parent_span_id, "span");
    if (entry.headers?.date) entry.headers.date = "<date>";
    if (entry.console_log) {
      // stdout and stderr arrive in no fixed order between them: sort by stream.
      entry.console_log = entry.console_log
        .map((log: any) => ({ ...log, timestamp: "<timestamp>", message: log.type === "stdin" ? "<stdin>" : log.message }))
        .sort((a: any, b: any) => a.type.localeCompare(b.type));
    }
    return JSON.parse(JSON.stringify(entry).replaceAll(port, "<port>"));
  });
};

testFeature(payload, features, "should match the snapshot of the log lines of an ssh ShellRequest", async () => {
  const { entries } = await lines("http://spawnlog.test/ssh");
  expect(mask(entries)).toMatchSnapshot();
});

testFeature(payload, features, "should match the snapshot of the log lines of a kubectl ShellRequest", async () => {
  const { entries } = await lines("http://spawnlog.test/kubectl");
  expect(mask(entries)).toMatchSnapshot();
});
