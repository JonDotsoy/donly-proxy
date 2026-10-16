import type { CurlRequest, CurlResponse } from "../types";
import { parseRemoteResult, remoteCommand, type Engine } from "../remote";
import { run, type RunResult } from "../run";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { quote } from "../quote";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let askpassProgram: string | undefined;

/**
 * A tiny program for `SSH_ASKPASS` that prints `$DONLY_SSH_PASSWORD`, so the password travels in
 * the environment of the ssh process instead of its command line. Only the owner can use it.
 */
const askpass = () => {
  if (!askpassProgram) {
    const dir = mkdtempSync(join(tmpdir(), "donly-proxy-askpass-"));
    askpassProgram = join(dir, "askpass.sh");
    writeFileSync(askpassProgram, `#!/bin/sh\nprintf '%s\\n' "$DONLY_SSH_PASSWORD"\n`);
    chmodSync(askpassProgram, 0o700);
  }
  return askpassProgram;
};

/** The ssh argv (options, destination, remote command) and the environment for the askpass protocol. */
const invocation = (request: CurlRequest, remote: string) => {
  // BatchMode forbids any prompt, including the askpass one: with a password it has to go.
  const auth = request.password === undefined ? ["-o", "BatchMode=yes"] : ["-o", "NumberOfPasswordPrompts=1"];
  const env =
    request.password === undefined
      ? undefined
      : { SSH_ASKPASS: askpass(), SSH_ASKPASS_REQUIRE: "force", DONLY_SSH_PASSWORD: request.password };
  return { argv: [...request.args.slice(0, -1), "-T", "-q", ...auth, request.args.at(-1)!, remote], env };
};

/**
 * Runs the request on a remote host over `ssh` with the chosen engine (`curl`, `wget` or `node`).
 * `args` are ssh options followed by the destination (`[-p 2222] user@host`). One ssh per request.
 */
export const sshRequest = async (request: CurlRequest, engine: Engine): Promise<CurlResponse> => {
  const { command, input } = remoteCommand(request, engine);
  const { argv, env } = invocation(request, command);
  return parseRemoteResult(await run("ssh", argv, input, request.onCommand, env, request.onExit, request.onConsole), engine, "ssh");
};

interface Session {
  key: string;
  command: string[];
  child: ChildProcess;
  busy: boolean;
  out: Buffer;
  err: Buffer[];
  timer?: ReturnType<typeof setTimeout>;
  pending?: { id: string; resolve: (result: RunResult) => void; reject: (error: Error) => void };
}

/** Wraps a remote command into one script for a long-lived `sh -s`: the answer comes back as a single framed line. */
const frame = (id: string, command: string, input: Buffer) => {
  const lines = input.toString("base64").match(/.{1,76}/g) ?? [];
  return [
    `e=$(mktemp) && o=$(mktemp) && {`,
    `base64 -d <<'DONLY_${id}' | ( ${command} ) > "$o" 2> "$e"`,
    ...lines,
    `DONLY_${id}`,
    `c=$?; printf '%s %s ' ${quote(`@@${id}`)} "$c"; base64 < "$o" | tr -d '\\n'; printf ' '; base64 < "$e" | tr -d '\\n'; printf '\\n'; rm -f "$o" "$e"`,
    `}`,
    ``,
  ].join("\n");
};

/**
 * Keeps `ssh` processes open between requests: the first request spawns `ssh <host> sh -s` and every
 * request after it is only more stdin for that process. A session closes (its stdin ends, so ssh
 * exits) once it has been idle for `idleTime` seconds. Sessions are pooled by their ssh arguments
 * and password; a busy session serves one request at a time, so concurrent requests open more.
 */
export class SshSessions {
  private sessions = new Set<Session>();

  async request(request: CurlRequest, engine: Engine, idleTime: number): Promise<CurlResponse> {
    const { command, input } = remoteCommand(request, engine);
    const key = JSON.stringify([request.args, request.password ?? null]);
    let session = [...this.sessions].find((s) => s.key === key && !s.busy);
    const reused = session !== undefined;
    session ??= this.open(request, key);
    session.busy = true;
    clearTimeout(session.timer);
    request.onStdin?.(session.command, reused, input.toString());
    const id = randomBytes(12).toString("hex");
    try {
      const result = await new Promise<RunResult>((resolve, reject) => {
        session.pending = { id, resolve, reject };
        session.child.stdin!.write(frame(id, command, input));
      });
      return parseRemoteResult(result, engine, "ssh");
    } finally {
      session.pending = undefined;
      session.busy = false;
      if (this.sessions.has(session)) session.timer = setTimeout(() => this.end(session), idleTime * 1000);
    }
  }

  /** Ends every session; ssh exits once its stdin is closed. */
  close() {
    for (const session of this.sessions) this.end(session);
  }

  private end(session: Session) {
    clearTimeout(session.timer);
    session.child.stdin!.end();
  }

  private open(request: CurlRequest, key: string) {
    const { argv, env } = invocation(request, "sh -s");
    const command = ["ssh", ...argv];
    request.onCommand?.(command);
    const child = spawn("ssh", argv, { stdio: ["pipe", "pipe", "pipe"], env: env && { ...process.env, ...env } });
    const session: Session = { key, command, child, busy: false, out: Buffer.alloc(0), err: [] };
    this.sessions.add(session);
    const fail = (error: Error) => session.pending?.reject(error);
    child.stdout!.on("data", (chunk: Buffer) => {
      session.out = Buffer.concat([session.out, chunk]);
      const marker = session.pending && session.out.indexOf(`@@${session.pending.id} `);
      if (marker === undefined || marker < 0) return;
      const end = session.out.indexOf("\n", marker);
      if (end < 0) return;
      const [, code, stdout, stderr] = session.out.subarray(marker, end).toString().split(" ");
      session.out = session.out.subarray(end + 1);
      session.pending!.resolve({ code: Number(code), stdout: Buffer.from(stdout ?? "", "base64"), stderr: Buffer.from(stderr ?? "", "base64") });
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      session.err.push(chunk);
      request.onConsole?.({ type: "stderr", timestamp: new Date().toISOString(), message: chunk.toString() });
    });
    child.stdin!.on("error", () => {});
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(session.timer);
      this.sessions.delete(session);
      request.onExit?.(code);
      fail(new Error(`ssh exited with ${code}: ${Buffer.concat(session.err).toString().trim() || "no output"}`));
    });
    return session;
  }
}
