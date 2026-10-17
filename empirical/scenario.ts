import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { ShellRequest, spawn } from "../src/spawn";
import { scenariosDir, validateSession, type SessionEntry } from "./session";

export interface ScenarioOptions {
  /** Name of the scenario and of its directory under `root`. */
  name: string;
  /** Programs recorded: each one gets a wrapper first in the `PATH` of the bash. */
  wrap: string[];
  /** What the bash runs (`bash -c`). */
  script: string;
  /** Extra environment for the bash. A `PATH` here replaces the one the wrapper directory is put in front of. */
  env?: Record<string, string>;
  /** Directory of the scenarios. Defaults to `empirical/__scenarios__`. */
  root?: string;
  /** Record again even if the scenario exists. */
  force?: boolean;
  /** The scenario fails (and leaves nothing on disk) if the script takes longer. Defaults to 60 s. */
  timeoutMs?: number;
}

export interface ScenarioSession {
  /** File of the session inside the scenario directory. */
  file: string;
  program: string;
  id: string;
  parent_session_id: string | null;
  exit_code: number | null;
  entries: SessionEntry[];
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

const wrapperScript = (program: string) =>
  `#!${process.execPath}\nimport { wrap } from ${JSON.stringify(resolve(import.meta.dir, "recorder.ts"))};\nawait wrap(${JSON.stringify(program)});\n`;

const text = async (stream: ReadableStream<Uint8Array>) => await new Response(stream).text();

/** Reads a recorded scenario: `scenario.json` and the session files it lists. */
const load = (name: string, root = scenariosDir): ScenarioResult => {
  const dir = join(root, name);
  const meta = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
  const sessions: ScenarioSession[] = meta.sessions.map((item: Omit<ScenarioSession, "entries">) => ({
    ...item,
    entries: JSON.parse(readFileSync(join(dir, item.file), "utf8")),
  }));
  return { ...meta, sessions, dir, recorded: false, stdout: "", stderr: "" };
};

const run = async (options: ScenarioOptions): Promise<ScenarioResult> => {
  const root = options.root ?? scenariosDir;
  const dir = join(root, options.name);
  if (existsSync(dir) && !options.force) return load(options.name, root);

  const id = crypto.randomUUID();
  const staging = join(root, `.${options.name}.${id}.tmp`);
  const bin = join(staging, ".bin");
  mkdirSync(bin, { recursive: true });
  try {
    for (const program of options.wrap) {
      writeFileSync(join(bin, program), wrapperScript(program));
      chmodSync(join(bin, program), 0o755);
    }
    const t0 = Date.now();
    const timestamp = new Date(t0).toISOString();
    const signal = AbortSignal.timeout(options.timeoutMs ?? 60_000);
    const request = new ShellRequest({
      commands: ["bash", "-c", options.script],
      signal,
      env: {
        ...options.env,
        PATH: `${bin}${delimiter}${options.env?.PATH ?? process.env.PATH}`,
        DONLY_SCENARIO_ID: id,
        DONLY_SCENARIO_NAME: options.name,
        DONLY_SCENARIO_DIR: staging,
        DONLY_SCENARIO_T0: String(t0),
        DONLY_SCENARIO_BIN: bin,
        DONLY_PARENT_SESSION: "",
      },
    });
    const response = await spawn(request);
    const [exitCode, stdout, stderr] = await Promise.all([response.exitCode, text(response.stdout), text(response.stderr)]);
    if (signal.aborted) throw new Error(`the scenario ${options.name} timed out`);
    

    // A claimed number without its file is a wrapper that died before it could write.
    const claims = existsSync(join(staging, ".claims")) ? readdirSync(join(staging, ".claims")).sort() : [];
    const files = readdirSync(staging).filter((file) => file.endsWith(".session.json")).sort();
    if (claims.length !== files.length) throw new Error(`the scenario ${options.name} has ${claims.length - files.length} incomplete session(s)`);

    const sessions: ScenarioSession[] = files.map((file) => {
      const entries: SessionEntry[] = JSON.parse(readFileSync(join(staging, file), "utf8"));
      validateSession(entries);
      const [start] = entries as [Extract<SessionEntry, { type: "session" }>];
      if (start.scenario_id !== id) throw new Error(`${file} belongs to another scenario`);
      const end = [...entries].reverse().find((entry) => entry.type === "end");
      return { file, program: file.replace(/^\d+-|\.session\.json$/g, ""), id: start.id, parent_session_id: start.parent_session_id, exit_code: end?.type === "end" ? end.exit_code : null, entries };
    });
    const ids = new Set(sessions.map((session) => session.id));
    for (const session of sessions) {
      if (session.parent_session_id !== null && !ids.has(session.parent_session_id)) throw new Error(`${session.file} has an unknown parent session`);
    }

    const meta = { id, timestamp, name: options.name, wrap: options.wrap, script: options.script, exit_code: exitCode, sessions: sessions.map(({ entries: _, ...item }) => item) };
    writeFileSync(join(staging, "scenario.json"), JSON.stringify(meta, null, 2));
    rmSync(bin, { recursive: true, force: true });
    rmSync(join(staging, ".claims"), { recursive: true, force: true });
    // The scenario only reaches its final place complete: a failed run leaves nothing and can be repeated.
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
    return { ...meta, sessions, dir, recorded: true, stdout, stderr };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
};

/**
 * Records real programs inside a bash. `Scenario.run` starts `bash -c <script>` with the wrappers of `wrap` first in the `PATH`;
 * each time the script (or a program it starts) runs one of them, the wrapper records a session file in the scenario directory.
 * The sessions of one scenario share its id, its time origin and, for nested calls, the parent session (see `recorder.ts`).
 */
export const Scenario = { run, load };
