import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { vfs } from "../src/utils/test_utils/vfs/vfs";
import { testFeature } from "../src/utils/test_utils/test-feature/test-feature";
import { proxyScript } from "./proxy-script";
import { Scenario } from "./scenario";
import { sessionText, validateSession, type RecordLine } from "./session";

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
const types = (lines: RecordLine[]) => lines.map((line) => line.type);

describe("Scenario", () => {
  test("records one wrapped call as a session with command, output and end", async () => {
    const root = roots();
    const scenario = await Scenario.run({ name: "single", wrap: ["node"], env: { PATH }, root, script: "node --version" });
    expect(scenario.exit_code).toBe(0);
    expect(scenario.sessions).toHaveLength(1);
    const [session] = scenario.sessions;
    expect(session!.file).toBe(join("records", `${session!.id}.ndjson`));
    expect(types(session!.lines)).toEqual(["command", "stdout", "end"]);
    expect(session).toMatchObject({ program: "node", args: ["--version"], exit_code: 0 });
    expect(sessionText(session!.lines, "stdout")).toBe("node --version\n");
    expect(readdirSync(join(root, "single")).sort()).toEqual(["records", "scenario.json"]);
    expect(readdirSync(join(root, "single", "records"))).toEqual([`${session!.id}.ndjson`]);
    expect(JSON.parse(readFileSync(join(root, "single", "scenario.json"), "utf8")).sessions[0].id).toBe(session!.id);
  });

  test("lists the sessions in the order the script ran them", async () => {
    const scenario = await Scenario.run({ name: "order", wrap: ["node", "curl"], env: { PATH }, root: roots(), script: "node a; curl x; node b" });
    expect(scenario.sessions.map((session) => [session.program, session.args[0]])).toEqual([["node", "a"], ["curl", "x"], ["node", "b"]]);
    // Each call starts after the previous one ended.
    const starts = scenario.sessions.map((session) => Date.parse(session.lines[0]!.timestamp));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  test("keeps every session apart when calls run in parallel", async () => {
    const calls = Array.from({ length: 12 }, (_, i) => `node call-${i} &`).join("\n");
    const scenario = await Scenario.run({ name: "parallel", wrap: ["node"], env: { PATH }, root: roots(), script: `${calls}\nwait` });
    expect(scenario.sessions).toHaveLength(12);
    expect(new Set(scenario.sessions.map((session) => session.file)).size).toBe(12);
    expect(new Set(scenario.sessions.map((session) => session.id)).size).toBe(12);
    expect(new Set(scenario.sessions.map((session) => session.args[0]))).toEqual(new Set(Array.from({ length: 12 }, (_, i) => `call-${i}`)));
  });

  test("records the calls a wrapped program makes to other wrapped programs", async () => {
    const scenario = await Scenario.run({ name: "nested", wrap: ["outer", "curl"], env: { PATH }, root: roots(), script: "outer; curl last" });
    expect(scenario.sessions.map((session) => [session.program, session.args[0]])).toEqual([["outer", undefined], ["curl", "--inner"], ["curl", "last"]]);
    expect(scenario.sessions[0]!.exit_code).toBe(4);
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

  // The count `wc` sees is not asserted: binrec exits before the output it wrote to a pipe has been flushed, so a pipe may get less than was recorded.
  test("records the whole output of a wrapped program that writes to a pipe", async () => {
    const scenario = await Scenario.run({ name: "pipe", wrap: ["big"], env: { PATH }, root: roots(), script: "big | wc -c" });
    expect(Number(scenario.stdout.trim())).toBeGreaterThan(0);
    expect(sessionText(scenario.sessions[0]!.lines, "stdout")).toHaveLength(3000000);
  });

  test("closes the session of a wrapper that gets a signal and stops the real program", async () => {
    const started = Date.now();
    const scenario = await Scenario.run({ name: "signal", wrap: ["slow"], env: { PATH }, root: roots(), script: "slow & pid=$!; sleep 1; kill -TERM $pid; wait $pid; echo status=$?" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(scenario.stdout.trim()).toBe("status=143");
    const [session] = scenario.sessions;
    expect(types(session!.lines).at(-1)).toBe("end");
    expect(session!.exit_code).toBe(143);
  });

  test("reports a wrapper killed before it could close its session", async () => {
    await expect(
      Scenario.run({ name: "killed", wrap: ["slow"], env: { PATH }, root: roots(), script: "slow & pid=$!; sleep 1; kill -KILL $pid; wait $pid; exit 0" }),
    ).rejects.toThrow("incomplete session");
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

  test("validateSession accepts a well-formed record and names what is wrong otherwise", () => {
    const at = (ms: number) => new Date(1_700_000_000_000 + ms).toISOString();
    const command: RecordLine = { type: "command", sessionId: "s", timestamp: at(0), performance: 1, command: "/bin/node", args: [] };
    const out: RecordLine = { type: "stdout", timestamp: at(1), performance: 2, size: 1, data: "x" };
    const end: RecordLine = { type: "end", timestamp: at(2), performance: 3, exitCode: 0, total: 1 };
    expect(() => validateSession([command, out, end])).not.toThrow();
    expect(() => validateSession([command, end])).not.toThrow();
    expect(() => validateSession([])).toThrow("opens with a `command`");
    expect(() => validateSession([out, end])).toThrow("opens with a `command`");
    expect(() => validateSession([command, command, end])).toThrow("exactly one `command`");
    expect(() => validateSession([command, end, out])).toThrow("`end` line closes");
    expect(() => validateSession([command, { ...end, exitCode: 1.5 }])).toThrow("exitCode");
    expect(() => validateSession([{ ...command, args: [1] } as unknown as RecordLine, end])).toThrow("string args");
    expect(() => validateSession([command, { ...out, timestamp: "yesterday" }, end])).toThrow("ISO date");
    expect(() => validateSession([command, { ...out, timestamp: at(5) }, { ...end, timestamp: at(2) }])).toThrow("time order");
    expect(() => validateSession([command, { ...out, data: 1 } as unknown as RecordLine, end])).toThrow("data");
    expect(() => validateSession("nope" as unknown as RecordLine[])).toThrow("array");
  });

  test("records a character split between two chunks without corrupting it", async () => {
    fake("utf", "printf '\\303'; sleep 0.3; printf '\\251'");
    const scenario = await Scenario.run({ name: "utf8", wrap: ["utf"], env: { PATH }, root: roots(), script: "utf" });
    expect(sessionText(scenario.sessions[0]!.lines, "stdout")).toBe("\u00e9");
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
  const byProxy = curls.find((session) => session.args.includes("http://scenario.test/page"))!;
  const direct = curls.find((session) => session !== byProxy)!;
  expect(direct.args).toEqual(["direct"]);
  expect(byProxy.args).toContain("--max-time");
  // The command the proxy logs is the call the wrapper recorded.
  const log = readFileSync(join(work, "proxy.ndjson"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const started = log.find((line) => line.type === "command_start");
  expect(started).toBeTruthy();
  expect(JSON.stringify(started)).toContain("http://scenario.test/page");
});

// The real curl is only the client that talks to the proxy; the one the proxy runs is the fake one, and it is the one recorded.
const client = Bun.which("curl");
const clientFeature = client ? testFeature : testFeature.skip;

const postManifest = `proxy {
  host "127.0.0.1"
  port 0
  route POST http://scenario.test/upload {
    command_pass curl "--max-time" "5"
  }
}
`;

clientFeature(postManifest, ["/proxy/route/command_pass", "/proxy/route/method"], "should record the body a POST sends to the curl of command_pass as its stdin", async (payload) => {
  const work = mkdtempSync(join(dir, "proxy-"));
  writeFileSync(join(work, "manifest.donly"), payload);
  const scenario = await Scenario.run({
    name: "proxy-post-body",
    wrap: ["curl"],
    root: roots(),
    env: { PATH, NO_PROXY: "", no_proxy: "" },
    script: proxyScript({ dir: work, bun: process.execPath, main: join(import.meta.dir, "..", "src", "cli", "main.ts"), client, requests: [{ host: "scenario.test", path: "/upload", method: "POST", body: "name=value&other=1" }] }),
  });
  expect(scenario.stdout).toContain("200 OK");
  expect(scenario.stdout).toContain("from curl");
  expect(scenario.sessions).toHaveLength(1);
  const [curl] = scenario.sessions;
  expect(sessionText(curl!.lines, "stdin")).toBe("name=value&other=1");
  expect(curl!.args).toEqual(expect.arrayContaining(["--request", "POST", "http://scenario.test/upload"]));
});

const httpsManifest = `proxy {
  host "127.0.0.1"
  port 0
  route https://secure.test/* {
    command_pass curl "--max-time" "5"
  }
}
`;

clientFeature(httpsManifest, ["/proxy/route/command_pass"], "should record the curl the proxy runs for a request that came through a CONNECT tunnel", async (payload) => {
  const work = mkdtempSync(join(dir, "proxy-"));
  writeFileSync(join(work, "manifest.donly"), payload);
  const scenario = await Scenario.run({
    name: "proxy-https",
    wrap: ["curl"],
    root: roots(),
    env: { PATH, NO_PROXY: "", no_proxy: "" },
    script: proxyScript({ dir: work, bun: process.execPath, main: join(import.meta.dir, "..", "src", "cli", "main.ts"), client, requests: [{ host: "secure.test", path: "/a?x=1", https: true }] }),
    timeoutMs: 20_000,
  });
  expect(scenario.stdout).toContain("from curl");
  expect(scenario.sessions).toHaveLength(1);
  expect(scenario.sessions[0]!.args).toContain("https://secure.test/a?x=1");
});
