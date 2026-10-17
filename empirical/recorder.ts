import { accessSync, closeSync, constants, mkdirSync, openSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { ShellRequest, SignalError, spawn } from "../src/spawn";
import type { SessionEntry } from "./session";

/**
 * Body of the wrapper binaries (`kubectl`, `ssh`, `curl`, `node`…) that a scenario puts first in the `PATH` of its bash.
 * It runs the real program of the same name, passes stdin, stdout and stderr through untouched, and writes the session
 * `NNNN-<program>.session.json` into the scenario directory: a `session` entry, a `command` entry with the program and its arguments,
 * every chunk as `{ elapse_nanosecond, type, chunk }` and an `end` entry with the exit code.
 *
 * Environment (set by `Scenario.run`, inherited by every process the script starts):
 * `DONLY_SCENARIO_ID`, `DONLY_SCENARIO_NAME`, `DONLY_SCENARIO_DIR` (where sessions go), `DONLY_SCENARIO_T0` (epoch ms the scenario began,
 * the origin of `elapse_nanosecond`) and `DONLY_SCENARIO_BIN` (the wrapper directory, skipped when looking for the real program).
 * `DONLY_PARENT_SESSION` is the session of the wrapped program that started this one; each wrapper sets it for its own child.
 */
const realProgram = (program: string) => {
  const skip = resolve(process.env.DONLY_SCENARIO_BIN ?? "");
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || resolve(dir) === skip) continue;
    const file = join(dir, program);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {}
  }
  throw new Error(`the real ${program} is not in the PATH`);
};

/** Claims the next number of the scenario with an exclusive create, so parallel wrappers never share one. */
const claim = (dir: string) => {
  const claims = join(dir, ".claims");
  mkdirSync(claims, { recursive: true });
  for (let n = 1; ; n++) {
    const name = String(n).padStart(4, "0");
    try {
      closeSync(openSync(join(claims, name), "wx"));
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
};

export const wrap = async (program: string) => {
  const dir = process.env.DONLY_SCENARIO_DIR!;
  const t0 = Number(process.env.DONLY_SCENARIO_T0);
  const real = realProgram(program);
  const number = claim(dir);
  const id = crypto.randomUUID();
  const entries: SessionEntry[] = [];
  const elapse = () => Math.round((performance.timeOrigin + performance.now() - t0) * 1e6);
  const record = (type: "stdin" | "stdout" | "stderr", chunk: Uint8Array) => entries.push({ elapse_nanosecond: elapse(), type, chunk: Buffer.from(chunk).toString() });

  entries.push({
    elapse_nanosecond: elapse(),
    type: "session",
    id,
    timestamp: new Date().toISOString(),
    name: process.env.DONLY_SCENARIO_NAME!,
    scenario_id: process.env.DONLY_SCENARIO_ID!,
    parent_session_id: process.env.DONLY_PARENT_SESSION || null,
  });
  const argv = process.argv.slice(2);
  entries.push({ elapse_nanosecond: elapse(), type: "command", command: program, args: argv });
  // The file exists from the start: a wrapper killed without a chance to finish leaves a session without `end`, which the scenario reports.
  const file = join(dir, `${number}-${program}.session.json`);
  const flush = () => writeFileSync(file, JSON.stringify(entries, null, 2));
  flush();
  // A reader that closes its end early (`| head`) must not crash the wrapper.
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
  // A signal goes to the real program, and the session is closed with the exit code it ends with.
  const stop = new AbortController();
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(name, () => stop.abort(new SignalError(name)));
  const request = new ShellRequest({ commands: [real, ...argv], stdin: new WritableStream(), env: { DONLY_PARENT_SESSION: id }, signal: stop.signal });
  const writer = request.stdin!.getWriter();
  // Not awaited: the program may finish without reading all of its input (or the input may never end).
  (async () => {
    for await (const chunk of process.stdin) {
      record("stdin", chunk);
      await writer.write(chunk);
    }
    await writer.close();
  })().catch(() => {});

  const response = await spawn(request);
  const pump = async (stream: ReadableStream<Uint8Array>, type: "stdout" | "stderr") => {
    for await (const chunk of stream) {
      record(type, chunk);
      // Wait until the chunk is handed over: exiting earlier would cut what a pipe still holds.
      await new Promise<void>((done) => process[type].write(chunk, () => done()));
    }
  };
  const [, , exitCode] = await Promise.all([pump(response.stdout, "stdout"), pump(response.stderr, "stderr"), response.exitCode]);

  entries.push({ elapse_nanosecond: elapse(), type: "end", exit_code: exitCode });
  flush();
  process.exit(exitCode ?? 1);
};
