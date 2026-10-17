import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { vfs } from "../src/utils/test_utils/vfs/vfs";
import { testFeature } from "../src/utils/test_utils/test-feature/test-feature";
import { proxyScript } from "./proxy-script";
import { Scenario } from "./scenario";
import { validateSession, type SessionEntry } from "./session";

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
fake("big", "head -c 3000000 /dev/zero | tr '\\0' x");
fake("slow", "exec sleep 8");
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
    const options = { name: "once", wrap: ["node"], root, env: { PATH, COUNTER: counter }, script: `echo x >> "$COUNTER"; node` };
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

  test("hands the whole output of a wrapped program to a pipe, as recorded", async () => {
    const scenario = await Scenario.run({ name: "pipe", wrap: ["big"], env: { PATH }, root: roots(), script: "big | wc -c" });
    expect(scenario.stdout.trim()).toBe("3000000");
    const recorded = scenario.sessions[0]!.entries.filter((entry) => entry.type === "stdout").map((entry) => (entry as { chunk: string }).chunk.length);
    expect(recorded.reduce((a, b) => a + b, 0)).toBe(3000000);
  });

  test("closes the session of a wrapper that gets a signal and stops the real program", async () => {
    const started = Date.now();
    const scenario = await Scenario.run({ name: "signal", wrap: ["slow"], env: { PATH }, root: roots(), script: "slow & pid=$!; sleep 1; kill -TERM $pid; wait $pid; echo status=$?" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(scenario.stdout.trim()).toBe("status=143");
    const [session] = scenario.sessions;
    expect(types(session!.entries).at(-1)).toBe("end");
    expect(session!.exit_code).toBe(143);
  });

  test("reports a wrapper killed before it could close its session", async () => {
    await expect(
      Scenario.run({ name: "killed", wrap: ["slow"], env: { PATH }, root: roots(), script: "slow & pid=$!; sleep 1; kill -KILL $pid; wait $pid; exit 0" }),
    ).rejects.toThrow("every command needs its end");
  });

  test("refuses names that point outside the root and programs it cannot find", async () => {
    const root = roots();
    for (const name of ["", "a/b", "../escape", ".", "..", ".hidden"]) {
      await expect(Scenario.run({ name, wrap: ["node"], env: { PATH }, root, script: "true" })).rejects.toThrow("invalid scenario name");
    }
    await expect(Scenario.run({ name: "absent", wrap: ["node", "no-such-program"], env: { PATH }, root, script: "true" })).rejects.toThrow("cannot wrap no-such-program");
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  });

  test("keeps the previous scenario when a forced run fails", async () => {
    const root = roots();
    const first = await Scenario.run({ name: "keep", wrap: ["node"], env: { PATH }, root, script: "node" });
    await expect(Scenario.run({ name: "keep", wrap: ["node"], env: { PATH }, root, script: "node; sleep 5", timeoutMs: 300, force: true })).rejects.toThrow("timed out");
    await expect(Scenario.run({ name: "keep", wrap: ["no-such-program"], env: { PATH }, root, script: "true", force: true })).rejects.toThrow("cannot wrap");
    expect(Scenario.load("keep", root).id).toBe(first.id);
    expect(readdirSync(root)).toEqual(["keep"]);
  });

  test("says what is wrong with a folder that is not a recorded scenario", async () => {
    const root = roots();
    mkdirSync(join(root, "empty"), { recursive: true });
    await expect(Scenario.run({ name: "empty", wrap: ["node"], env: { PATH }, root, script: "node" })).rejects.toThrow("exists without scenario.json");
    expect(() => Scenario.load("empty", root)).toThrow("is not recorded");
    expect(() => Scenario.load("never", root)).toThrow("is not recorded");
    const forced = await Scenario.run({ name: "empty", wrap: ["node"], env: { PATH }, root, script: "node", force: true });
    expect(forced.sessions).toHaveLength(1);
  });

  // Sessions written by hand into the directory of the scenario, as a wrapper would, to check what `Scenario.run` refuses.
  const injected = (entries: SessionEntry[], claims = ["0001"]) => {
    const file = join(dir, `injected-${seq++}.json`);
    writeFileSync(file, JSON.stringify(entries));
    return `mkdir -p "$DONLY_SCENARIO_DIR/.claims"; ${claims.map((claim) => `touch "$DONLY_SCENARIO_DIR/.claims/${claim}"`).join("; ")}; sed "s/__ID__/$DONLY_SCENARIO_ID/" ${file} > "$DONLY_SCENARIO_DIR/0001-node.session.json"`;
  };
  const session = (extra: Partial<Extract<SessionEntry, { type: "session" }>> = {}): SessionEntry[] => [
    { elapse_nanosecond: 1, type: "session", id: "s1", timestamp: new Date().toISOString(), name: "x", scenario_id: "__ID__", parent_session_id: null, ...extra },
    { elapse_nanosecond: 2, type: "command", command: "node", args: [] },
    { elapse_nanosecond: 3, type: "end", exit_code: 0 },
  ];

  test("refuses sessions that do not belong to the scenario, have an unknown parent or are missing", async () => {
    const options = { wrap: ["node"], env: { PATH }, root: roots() };
    await expect(Scenario.run({ ...options, name: "foreign", script: injected(session({ scenario_id: "another" })) })).rejects.toThrow("belongs to another scenario");
    await expect(Scenario.run({ ...options, name: "unknown-parent", script: injected(session({ parent_session_id: "nobody" })) })).rejects.toThrow("unknown parent session");
    const twoCalls = session();
    twoCalls.push({ elapse_nanosecond: 4, type: "command", command: "node", args: [] }, { elapse_nanosecond: 5, type: "end", exit_code: 0 });
    await expect(Scenario.run({ ...options, name: "two-calls", script: injected(twoCalls) })).rejects.toThrow("exactly one call");
    const fine = await Scenario.run({ ...options, name: "injected", script: injected(session()) });
    expect(fine.sessions.map((item) => item.id)).toEqual(["s1"]);
    await expect(Scenario.run({ ...options, name: "missing-file", script: injected(session(), ["0001", "0002"]) })).rejects.toThrow("incomplete session");
    expect(readdirSync(options.root)).toEqual(["injected"]);
  });

  test("validateSession accepts a well-formed session and names what is wrong otherwise", () => {
    const good = session({ scenario_id: "s" });
    expect(() => validateSession(good)).not.toThrow();
    const [open, command, end] = good as [SessionEntry, SessionEntry, SessionEntry];
    expect(() => validateSession([])).toThrow("opens with a `session`");
    expect(() => validateSession([command, end])).toThrow("opens with a `session`");
    expect(() => validateSession([open, open, command, end])).toThrow("exactly one `session`");
    expect(() => validateSession([open, command])).toThrow("needs its end");
    expect(() => validateSession([{ ...open, elapse_nanosecond: -1 } as SessionEntry, command, end])).toThrow("elapse_nanosecond");
    expect(() => validateSession([{ ...open, elapse_nanosecond: 1.5 } as SessionEntry, command, end])).toThrow("elapse_nanosecond");
    expect(() => validateSession([{ ...(open as object), timestamp: "yesterday" } as SessionEntry, command, end])).toThrow();
    expect(() => validateSession([open, { ...command, args: [1] } as unknown as SessionEntry, end])).toThrow("string args");
    expect(() => validateSession([open, command, { ...end, exit_code: 1.5 } as SessionEntry])).toThrow("exit_code");
    expect(() => validateSession([open, command, { elapse_nanosecond: 3, type: "stdout", chunk: 1 } as unknown as SessionEntry, end])).toThrow("chunk");
    expect(() => validateSession("nope" as unknown as SessionEntry[])).toThrow("array");
    expect(() => validateSession([open, end, command])).toThrow("needs the command it closes");
    expect(() => validateSession([open, command, command, end])).toThrow("cannot open before");
    expect(() => validateSession([open, { elapse_nanosecond: 2, type: "stdout", chunk: "x" }, command, end])).toThrow("between a command and its end");
    expect(() => validateSession([open, { ...command, elapse_nanosecond: 5 }, { ...end, elapse_nanosecond: 4 }])).toThrow("time order");
    expect(() => validateSession([open, command, { elapse_nanosecond: 3, type: "other" } as unknown as SessionEntry, end])).toThrow("unknown entry type");
  });

  test("records a character split between two chunks without corrupting it", async () => {
    fake("utf", "printf '\\303'; sleep 0.3; printf '\\251'");
    const scenario = await Scenario.run({ name: "utf8", wrap: ["utf"], env: { PATH }, root: roots(), script: "utf" });
    const text = scenario.sessions[0]!.entries.filter((entry) => entry.type === "stdout").map((entry) => (entry as { chunk: string }).chunk).join("");
    expect(text).toBe("\u00e9");
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
const manifest = `proxy {
  host "127.0.0.1"
  port 0
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
  const scenario = await Scenario.run({
    name: "proxy-command-pass",
    wrap: ["curl"],
    root: roots(),
    env: { PATH, NO_PROXY: "", no_proxy: "" },
    script: proxyScript({ dir: work, bun: process.execPath, main, requests: [{ host: "scenario.test", path: "/page" }], after: "curl direct < /dev/null" }),
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
