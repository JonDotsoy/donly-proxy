import { binrec } from "@jondotsoy/binrec";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { ShellRequest, spawn } from "../src/spawn";
import { scenariosDir, validateSession, type RecordLine } from "./session";

export interface ScenarioOptions {
  /** Name of the scenario and of its directory under `root`. */
  name: string;
  /** Programs recorded: each one gets a wrapper first in the `PATH` of the bash. */
  wrap: string[];
  /** What the bash runs (`bash -c`). */
  script: string;
  /** Extra environment for the bash. A `PATH` here replaces the inherited one: the wrapper directory goes in front of it, and `bash` and the wrapped programs are looked up in it. */
  env?: Record<string, string>;
  /** Directory the bash starts in: a path, or a `vfs` (its `cwd()`). Defaults to the one of this process. */
  cwd?: string | { cwd(): string };
  /** Directory of the scenarios. Defaults to `empirical/__scenarios__`. */
  root?: string;
  /** Record again even if the scenario exists. */
  force?: boolean;
  /** The scenario fails (and leaves nothing on disk) if the script takes longer. Defaults to 60 s. */
  timeoutMs?: number;
}

export interface ScenarioSession {
  /** File of the session inside the scenario directory (`records/<id>.ndjson`, a binrec record). */
  file: string;
  /** Name of the wrapped program, as the script called it. */
  program: string;
  id: string;
  /** Path of the real program that ran. */
  command: string;
  args: string[];
  exit_code: number;
  /** The lines of the record: `command`, the `stdin`/`stdout`/`stderr` chunks and `end`. */
  lines: RecordLine[];
}

export interface ScenarioResult {
  id: string;
  name: string;
  timestamp: string;
  wrap: string[];
  script: string;
  /** Exit code of the bash. */
  exit_code: number;
  /** Sessions in the order they started. */
  sessions: ScenarioSession[];
  dir: string;
  /** Whether this call ran the script (`false`: it was already recorded). */
  recorded: boolean;
  /** What the script itself printed (not recorded on disk; empty when the scenario was loaded). */
  stdout: string;
  stderr: string;
}

const text = async (stream: ReadableStream<Uint8Array>) => await new Response(stream).text();

/** Reads a recorded scenario: `scenario.json` and the session files it lists. */
const load = (name: string, root = scenariosDir): ScenarioResult => {
  const dir = join(root, name);
  if (!existsSync(join(dir, "scenario.json"))) throw new Error(`the scenario ${name} is not recorded (no scenario.json in ${dir})`);
  const meta = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
  const sessions: ScenarioSession[] = meta.sessions.map((item: Omit<ScenarioSession, "lines">) => ({
    ...item,
    lines: readFileSync(join(dir, item.file), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  }));
  return { ...meta, sessions, dir, recorded: false, stdout: "", stderr: "" };
};

const run = async (options: ScenarioOptions): Promise<ScenarioResult> => {
  // The name is a folder under `root`: it cannot point anywhere else.
  if (!/^[A-Za-z0-9][\w.-]*$/.test(options.name)) throw new Error(`invalid scenario name ${JSON.stringify(options.name)}: use letters, digits, "_", "-" and "."`);
  const root = options.root ?? scenariosDir;
  const dir = join(root, options.name);
  if (existsSync(dir) && !options.force) {
    if (!existsSync(join(dir, "scenario.json"))) throw new Error(`${dir} exists without scenario.json: delete it or run with force`);
    return load(options.name, root);
  }
  // A wrapper cannot record a program it cannot find: fail before running anything (and before replacing a good scenario).
  const path = options.env?.PATH ?? process.env.PATH;
  const absent = options.wrap.filter((program) => /[\\/]/.test(program) || !Bun.which(program, { PATH: path }));
  if (absent.length) throw new Error(`cannot wrap ${absent.join(", ")}: not found in the PATH of the scenario`);

  const id = crypto.randomUUID();
  const staging = join(root, `.${options.name}.${id}.tmp`);
  // binrec puts its config next to the shim folder and the records in the folder given.
  const recorder = binrec.create({ path: join(staging, ".bin"), records: join(staging, "records") });
  mkdirSync(staging, { recursive: true });
  try {
    // The shims point at the programs found in the PATH of the scenario, which is not always the one of this process.
    for (const program of options.wrap) await recorder.install(Bun.which(program, { PATH: path })!);
    const timestamp = new Date().toISOString();
    const signal = AbortSignal.timeout(options.timeoutMs ?? 60_000);
    const request = new ShellRequest({
      commands: [Bun.which("bash") ?? "bash", "-c", options.script],
      signal,
      cwd: typeof options.cwd === "string" ? options.cwd : options.cwd?.cwd(),
      env: { ...options.env, PATH: `${recorder.path}${delimiter}${path}` },
    });
    const response = await spawn(request);
    const [exitCode, stdout, stderr] = await Promise.all([response.exitCode, text(response.stdout), text(response.stderr)]);
    if (signal.aborted) throw new Error(`the scenario ${options.name} timed out`);

    const sessions: ScenarioSession[] = (await recorder.sessions())
      .map((record) => {
        // A shim killed before it could write the `end` line leaves a record without exit code.
        if (record.exitCode === null) throw new Error(`the scenario ${options.name} has an incomplete session (${basename(record.command)}, ${record.sessionId})`);
        validateSession(record.lines as RecordLine[]);
        return {
          file: join("records", `${record.sessionId}.ndjson`),
          program: basename(record.command),
          id: record.sessionId,
          command: record.command,
          args: record.args,
          exit_code: record.exitCode,
          lines: record.lines as RecordLine[],
        };
      })
      .sort((a, b) => Date.parse(a.lines[0]!.timestamp) - Date.parse(b.lines[0]!.timestamp));

    const meta = { id, timestamp, name: options.name, wrap: options.wrap, script: options.script, exit_code: exitCode, sessions: sessions.map(({ lines: _, ...item }) => item) };
    writeFileSync(join(staging, "scenario.json"), JSON.stringify(meta, null, 2));
    // Only the records stay: the shims, binrec's config and its stats files are not part of the scenario.
    rmSync(recorder.path, { recursive: true, force: true });
    rmSync(recorder.config, { force: true });
    if (existsSync(recorder.records)) for (const file of readdirSync(recorder.records)) if (file.endsWith(".stats.json")) rmSync(join(recorder.records, file));
    // The scenario only reaches its final place complete: a failed run leaves nothing and can be repeated.
    // The previous one (force) is set aside first, so a failure here does not lose it.
    const previous = `${staging}.previous`;
    if (existsSync(dir)) renameSync(dir, previous);
    try {
      renameSync(staging, dir);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, dir);
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });
    return { ...meta, sessions, dir, recorded: true, stdout, stderr };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
};

/**
 * Records real programs inside a bash. `Scenario.run` starts `bash -c <script>` with a binrec shim for each program of `wrap` first in the `PATH`;
 * each time the script (or a program it starts) runs one of them, binrec records a session (an ndjson file in `records/`) in the scenario directory.
 * `scenario.json` lists the sessions of the scenario in the order they started.
 */
export const Scenario = { run, load };
