import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { vfs } from "../src/utils/test_utils/vfs/vfs";
import { testFeature } from "../src/utils/test_utils/test-feature/test-feature";
import { Scenario } from "./scenario";
import type { SessionEntry } from "./session";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-scenario-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Fake programs the wrappers run instead of the real ones, so the tests need no network and no installed tools.
const fakes = join(dir, "fakes");
mkdirSync(fakes);
const fake = (name: string, body: string) => {
  writeFileSync(join(fakes, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(fakes, name), 0o755);
};
fake("node", 'echo "node $*"; [ -n "$NODE_EXIT" ] && exit "$NODE_EXIT"; exit 0');
fake("curl", 'cat > /dev/null; printf \'200\\n{"content-type":["text/plain"]}\' >&2; printf "from curl"');
fake("outer", "curl --inner one; exit 4");
const PATH = `${fakes}${delimiter}${process.env.PATH}`;

let seq = 0;
const roots = () => join(dir, `root-${seq++}`);
const types = (entries: SessionEntry[]) => entries.map((entry) => entry.type);

describe("Scenario", () => {
  test("records one wrapped call as a session with command, output and end", async () => {
    const root = roots();
    const scenario = await Scenario.run({ name: "single", wrap: ["node"], env: { PATH }, root, script: "node --version" });
    expect(scenario.exit_code).toBe(0);
    expect(scenario.sessions).toHaveLength(1);
    const [session] = scenario.sessions;
    expect(session!.file).toBe("0001-node.session.json");
    expect(types(session!.entries)).toEqual(["session", "command", "stdout", "end"]);
    expect(session!.entries[1]).toMatchObject({ command: "node", args: ["--version"] });
    expect(session!.entries[2]).toMatchObject({ chunk: "node --version\n" });
    expect(session!.entries[0]).toMatchObject({ name: "single", scenario_id: scenario.id, parent_session_id: null });
    expect(readdirSync(join(root, "single")).sort()).toEqual(["0001-node.session.json", "scenario.json"]);
    expect(JSON.parse(readFileSync(join(root, "single", "scenario.json"), "utf8")).sessions[0].id).toBe(session!.id);
  });

  test("numbers the sessions in the order the script ran them", async () => {
    const scenario = await Scenario.run({ name: "order", wrap: ["node", "curl"], env: { PATH }, root: roots(), script: "node a; curl x; node b" });
    expect(scenario.sessions.map((session) => session.file)).toEqual(["0001-node.session.json", "0002-curl.session.json", "0003-node.session.json"]);
    // One time origin for the whole scenario: each call starts after the previous one ended.
    const starts = scenario.sessions.map((session) => session.entries[0]!.elapse_nanosecond);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(new Set(scenario.sessions.map((session) => (session.entries[0] as { scenario_id: string }).scenario_id))).toEqual(new Set([scenario.id]));
  });

  test("keeps every session apart when calls run in parallel", async () => {
    const calls = Array.from({ length: 12 }, (_, i) => `node call-${i} &`).join("\n");
    const scenario = await Scenario.run({ name: "parallel", wrap: ["node"], env: { PATH }, root: roots(), script: `${calls}\nwait` });
    expect(scenario.sessions).toHaveLength(12);
    expect(new Set(scenario.sessions.map((session) => session.file)).size).toBe(12);
    expect(new Set(scenario.sessions.map((session) => session.id)).size).toBe(12);
    expect(new Set(scenario.sessions.map((session) => (session.entries[1] as { args: string[] }).args[0]))).toEqual(new Set(Array.from({ length: 12 }, (_, i) => `call-${i}`)));
  });

  test("links a call made by a wrapped program to the session of its parent", async () => {
    const scenario = await Scenario.run({ name: "nested", wrap: ["outer", "curl"], env: { PATH }, root: roots(), script: "outer; curl last" });
    const [outer, inner, last] = scenario.sessions;
    expect(outer!.program).toBe("outer");
    expect(inner).toMatchObject({ program: "curl", parent_session_id: outer!.id });
    expect(last).toMatchObject({ program: "curl", parent_session_id: null });
    expect(outer!.exit_code).toBe(4);
  });

  test("does not record programs outside wrap and keeps the exit codes", async () => {
    const scenario = await Scenario.run({ name: "codes", wrap: ["node"], env: { PATH, NODE_EXIT: "3" }, root: roots(), script: "echo plain; curl ignored < /dev/null; node; exit 7" });
    expect(scenario.exit_code).toBe(7);
    expect(scenario.stdout).toContain("plain");
    expect(scenario.sessions.map((session) => session.program)).toEqual(["node"]);
    expect(scenario.sessions[0]!.exit_code).toBe(3);
  });

  test("records a scenario only once unless it is forced", async () => {
    const root = roots();
    const counter = join(dir, `counter-${seq}`);
    const options = { name: "once", wrap: ["node"], env: { PATH }, root, script: `echo x >> ${counter}; node` };
    const first = await Scenario.run(options);
    const second = await Scenario.run(options);
    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    expect(second.sessions.map((session) => session.id)).toEqual(first.sessions.map((session) => session.id));
    expect(readFileSync(counter, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
    const forced = await Scenario.run({ ...options, force: true });
    expect(forced.recorded).toBe(true);
    expect(forced.id).not.toBe(first.id);
    expect(readFileSync(counter, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    expect(Scenario.load("once", root).id).toBe(forced.id);
  });

  test("starts the script in the cwd, a path or a vfs", async () => {
    const files = vfs.createTmp();
    files.writeFile("foo", "from vfs");
    const options = { wrap: ["node"], env: { PATH }, script: "pwd; cat foo; node here" } as const;
    const viaVfs = await Scenario.run({ ...options, name: "cwd-vfs", root: roots(), cwd: files });
    expect(viaVfs.stdout).toBe(`${files.cwd()}\nfrom vfsnode here\n`);
    expect(viaVfs.sessions).toHaveLength(1);
    const viaPath = await Scenario.run({ ...options, name: "cwd-path", root: roots(), cwd: files.cwd() });
    expect(viaPath.stdout).toBe(`${files.cwd()}\nfrom vfsnode here\n`);
    const without = await Scenario.run({ ...options, name: "cwd-none", root: roots(), script: "pwd" });
    expect(without.stdout.trim()).toBe(process.cwd());
    files.remove();
  });

  test("leaves nothing on disk when the scenario times out", async () => {
    const root = roots();
    await expect(Scenario.run({ name: "slow", wrap: ["node"], env: { PATH }, root, script: "node; sleep 5", timeoutMs: 300 })).rejects.toThrow("timed out");
    expect(existsSync(join(root, "slow"))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});

// The proxy is the subject: a scenario starts it with a manifest and asks it for a page; the proxy runs `curl` through `command_pass`,
// and the wrapper records that call next to the one the script made itself.
const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = probe.port;
probe.stop(true);

const manifest = `proxy {
  host "127.0.0.1"
  port ${port}
  log_file "./proxy.ndjson"
  route http://scenario.test/* {
    command_pass curl "--max-time" "5"
  }
}
`;

testFeature(manifest, ["/proxy/route/command_pass"], "should record the curl the proxy runs for command_pass in a scenario", async (payload) => {
  const work = mkdtempSync(join(dir, "proxy-"));
  writeFileSync(join(work, "manifest.donly"), payload);
  const main = join(import.meta.dir, "..", "src", "cli", "main.ts");
  const request = "GET http://scenario.test/page HTTP/1.1\\r\\nHost: scenario.test\\r\\nConnection: close\\r\\n\\r\\n";
  const scenario = await Scenario.run({
    name: "proxy-command-pass",
    wrap: ["curl"],
    root: roots(),
    env: { PATH, NO_PROXY: "", no_proxy: "" },
    script: `
      cd ${JSON.stringify(work)}
      ${JSON.stringify(process.execPath)} ${JSON.stringify(main)} manifest.donly > proxy.out 2>&1 &
      proxy=$!
      for _ in $(seq 100); do (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && break; sleep 0.1; done
      exec 3<>/dev/tcp/127.0.0.1/${port}
      printf '${request}' >&3
      cat <&3
      curl direct < /dev/null
      kill $proxy
      wait $proxy
      exit 0
    `,
  });
  expect(scenario.stdout).toContain("from curl");
  const curls = scenario.sessions.filter((session) => session.program === "curl");
  expect(curls).toHaveLength(2);
  const byProxy = curls.find((session) => (session.entries[1] as { args: string[] }).args.includes("http://scenario.test/page"))!;
  const direct = curls.find((session) => session !== byProxy)!;
  expect((direct.entries[1] as { args: string[] }).args).toEqual(["direct"]);
  expect((byProxy.entries[1] as { args: string[] }).args).toContain("--max-time");
  expect(new Set(curls.map((session) => (session.entries[0] as { scenario_id: string }).scenario_id))).toEqual(new Set([scenario.id]));
  // The command the proxy logs is the call the wrapper recorded.
  const log = readFileSync(join(work, "proxy.ndjson"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const started = log.find((line) => line.type === "command_start");
  expect(started).toBeTruthy();
  expect(JSON.stringify(started)).toContain("http://scenario.test/page");
});
