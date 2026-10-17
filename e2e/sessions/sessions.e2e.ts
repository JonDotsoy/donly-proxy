import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createProxyServer, loadConfig } from "../../src/proxy/server";
import { sessionPath, sessionsDir, type SessionEntry } from "./session";

// Empirical sessions: runs REAL programs (kubectl, ssh, curl…) through wrapper binaries that record every stdin, stdout
// and stderr chunk as `{ elapse_nanosecond, type, chunk }` in e2e/sessions/__sessions__/<name>.session.json, either from a Bun.$ command
// or from a request through the proxy with a manifest. A session whose file exists is NOT recorded again: delete the file to
// record it again. Programs or settings a session needs and the machine lacks make it skip (the file is not created).
const root = mkdtempSync(join(tmpdir(), "donly-proxy-sessions-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const hasProgram = (program: string) => Bun.which(program) !== null;
const words = (value = "") => value.split(/\s+/).filter(Boolean);
const quoted = (args: string[]) => args.map((arg) => JSON.stringify(arg)).join(" ");

interface Session {
  name: string;
  /** What the session shows, saved in its `session_start` entry. */
  summary: string;
  programs: string[];
  /** Why the session cannot be recorded on this machine, if so (missing environment variable). */
  unavailable?: string;
  run: (env: Record<string, string>) => Promise<void>;
}

/** Runs a command with Bun.$ (only here, in the tests); a failing command is part of the session, not an error. */
const shell = (command: string[]): Session["run"] => async (env) => {
  // An explicit empty stdin: programs that read it must not wait for the one of the test runner.
  await Bun.$`${command} < ${new Response("")}`.env(env).nothrow().quiet();
};

/** Starts the proxy with a manifest, sends `GET http://<host><path>` through it and checks the answer. */
const manifest = (route: string, expectInBody: RegExp): Session["run"] => async (env) => {
  const dir = mkdtempSync(join(root, "manifest-"));
  const file = join(dir, "manifest.donly");
  writeFileSync(file, `proxy {\n  host "127.0.0.1"\n  port 0\n  route http://api.ipify.org/* {\n${route}\n  }\n}\n`);
  const saved = { ...process.env };
  Object.assign(process.env, env, { NO_PROXY: "", no_proxy: "" });
  const server = createProxyServer(await loadConfig(file));
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch("http://api.ipify.org/?format=json", { proxy });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(expectInBody);
  } finally {
    server.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
};

const ssh = process.env.DONLY_E2E_SSH; // `user@host`; DONLY_E2E_SSH_ARGS: ssh options such as `-p 22 -i ~/.ssh/key`
const kubectl = process.env.DONLY_E2E_KUBECTL_POD; // `pod/name`; DONLY_E2E_KUBECTL_ARGS: kubectl options such as `-n prod`
const ipJson = /"ip":\s*"[\d.:a-f]+"/;

const sessions: Session[] = [
  { name: "curl-version", summary: "curl --version run with Bun.$", programs: ["curl"], run: shell(["curl", "--version"]) },
  { name: "wget-version", summary: "wget --version run with Bun.$", programs: ["wget"], run: shell(["wget", "--version"]) },
  { name: "node-version", summary: "node --version run with Bun.$", programs: ["node"], run: shell(["node", "--version"]) },
  { name: "kubectl-version", summary: "kubectl version --client run with Bun.$", programs: ["kubectl"], run: shell(["kubectl", "version", "--client"]) },
  { name: "kubectl-unreachable-cluster", summary: "kubectl get pods against a cluster that refuses the connection", programs: ["kubectl"], run: shell(["kubectl", "--server=https://127.0.0.1:1", "get", "pods"]) },
  { name: "ssh-version", summary: "ssh -V run with Bun.$ (prints on stderr)", programs: ["ssh"], run: shell(["ssh", "-V"]) },
  { name: "ssh-connection-refused", summary: "ssh to a port nobody listens on, in batch mode", programs: ["ssh"], run: shell(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "-p", "1", "nobody@127.0.0.1", "true"]) },
  // The proxy fetches the public IP of this machine with each real program.
  { name: "manifest-curl-public-ip", summary: "command_pass curl asking api.ipify.org for the public IP through the proxy", programs: ["curl"], run: manifest(`    command_pass curl "--max-time" "15"`, ipJson) },
  { name: "manifest-node-public-ip", summary: "command_pass node asking api.ipify.org for the public IP through the proxy", programs: ["node"], run: manifest(`    command_pass node`, ipJson) },
  {
    name: "manifest-ssh-pass-public-ip",
    summary: "ssh_pass with a nested curl asking api.ipify.org for the public IP through the proxy",
    programs: ["ssh"],
    unavailable: ssh ? undefined : "set DONLY_E2E_SSH=user@host",
    run: manifest(`    ssh_pass ${quoted([...words(process.env.DONLY_E2E_SSH_ARGS), ssh ?? ""])} {\n      command_pass curl\n    }`, ipJson),
  },
  {
    name: "manifest-kubectl-pass-public-ip",
    summary: "kubectl_pass with a nested curl asking api.ipify.org for the public IP through the proxy",
    programs: ["kubectl"],
    unavailable: kubectl ? undefined : "set DONLY_E2E_KUBECTL_POD=pod/name",
    run: manifest(`    kubectl_pass ${quoted([...words(process.env.DONLY_E2E_KUBECTL_ARGS), kubectl ?? ""])} {\n      command_pass curl\n    }`, ipJson),
  },
];

const wrapperScript = (program: string) =>
  `#!${process.execPath}\nimport { wrap } from ${JSON.stringify(resolve(import.meta.dir, "wrapper.ts"))};\nawait wrap(${JSON.stringify(program)});\n`;

for (const session of sessions) {
  const file = sessionPath(session.name);
  const missing = session.programs.filter((program) => !hasProgram(program));
  const reason = existsSync(file) ? "session already recorded" : missing.length ? `missing ${missing.join(", ")}` : session.unavailable;
  test.skipIf(reason !== undefined)(`records the session ${session.name}${reason ? ` (skipped: ${reason})` : ""}`, async () => {
    const dir = mkdtempSync(join(root, "session-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // One wrapper per real program the session may call (the proxy can also call curl or node on its own).
    for (const program of new Set([...session.programs, "curl", "node"])) {
      if (!hasProgram(program)) continue;
      writeFileSync(join(bin, program), wrapperScript(program));
      chmodSync(join(bin, program), 0o755);
    }
    const recording = join(dir, "recording.session.json");
    const t0 = Date.now();
    const start: SessionEntry = { elapse_nanosecond: 0, type: "session_start", id: crypto.randomUUID(), timestamp: new Date(t0).toISOString(), name: session.name, summary: session.summary };
    writeFileSync(recording, JSON.stringify([start], null, 2));
    const env = {
      ...(process.env as Record<string, string>),
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      DONLY_SESSION_FILE: recording,
      DONLY_SESSION_T0: String(t0),
      DONLY_SESSION_BIN: bin,
    };
    await session.run(env);

    // The recording only reaches its final place when the whole session ran: a failed run can be repeated.
    const entries: SessionEntry[] = JSON.parse(readFileSync(recording, "utf8"));
    // The file opens once with `session_start`.
    expect(entries[0]).toMatchObject({ type: "session_start", name: session.name, elapse_nanosecond: 0 });
    expect(entries.filter((entry) => entry.type === "session_start").length).toBe(1);
    for (const entry of entries) {
      expect(["session_start", "command", "stdin", "stdout", "stderr", "end"]).toContain(entry.type);
      expect(Number.isInteger(entry.elapse_nanosecond) && entry.elapse_nanosecond >= 0).toBe(true);
      if (entry.type === "session_start") expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
      else if (entry.type === "command") {
        expect(typeof entry.command).toBe("string");
        expect(entry.args.every((arg) => typeof arg === "string")).toBe(true);
      }
      else if (entry.type === "end") expect(entry.exit_code === null || Number.isInteger(entry.exit_code)).toBe(true);
      else expect(typeof entry.chunk).toBe("string");
    }
    // Every call opens with `command` and closes with `end`.
    expect(entries.filter((entry) => entry.type === "command").length).toBe(entries.filter((entry) => entry.type === "end").length);
    mkdirSync(sessionsDir, { recursive: true });
    renameSync(recording, file);
  });
}
