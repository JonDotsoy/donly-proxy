import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { ShellRequest, spawn } from "../../src/spawn";
import type { SessionCall, SessionEntry } from "./session";

/**
 * Body of the wrapper binaries (`kubectl`, `ssh`, `curl`…) that e2e/sessions puts first in the `PATH`.
 * It runs the real program of the same name, passes stdin, stdout and stderr through untouched, and appends
 * a `command` entry with its arguments and every chunk to the session file as `{ perf, type, chunk }`.
 *
 * Environment: `DONLY_SESSION_FILE` (where to record), `DONLY_SESSION_T0` (epoch ms the session began,
 * the origin of `perf`) and `DONLY_SESSION_BIN` (the wrapper directory, skipped when looking for the real program).
 */
const realProgram = (program: string) => {
  const skip = resolve(process.env.DONLY_SESSION_BIN ?? "");
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

const append = <T>(file: string, items: T[]) => {
  const current: T[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  writeFileSync(file, JSON.stringify([...current, ...items], null, 2));
};

export const wrap = async (program: string) => {
  const file = process.env.DONLY_SESSION_FILE!;
  const t0 = Number(process.env.DONLY_SESSION_T0);
  const entries: SessionEntry[] = [];
  const perf = () => Math.round((performance.timeOrigin + performance.now() - t0) * 1e6);
  const record = (type: "stdin" | "stdout" | "stderr", chunk: Uint8Array) => entries.push({ perf: perf(), type, chunk: Buffer.from(chunk).toString() });

  const argv = process.argv.slice(2);
  entries.push({ perf: perf(), type: "command", args: argv });
  const request = new ShellRequest({ commands: [realProgram(program), ...argv], stdin: new WritableStream() });
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
      process[type].write(chunk);
    }
  };
  const [, , exitCode] = await Promise.all([pump(response.stdout, "stdout"), pump(response.stderr, "stderr"), response.exitCode]);

  append(file, entries);
  append<SessionCall>(file.replace(/\.session\.json$/, ".calls.json"), [{ program, argv, exitCode }]);
  process.exit(exitCode ?? 1);
};
