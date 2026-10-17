import { resolve } from "node:path";

/** One thing a wrapped program read or wrote. `perf` is nanoseconds since the test started (performance API). */
export interface SessionEntry {
  perf: number;
  type: "stdin" | "stdout" | "stderr";
  chunk: string;
}

/** How a wrapped program was called and how it ended; one per call, in the order the calls started. */
export interface SessionCall {
  program: string;
  argv: string[];
  exitCode: number | null;
}

export const sessionsDir = resolve(import.meta.dir, "__sessions__");
export const sessionPath = (name: string) => resolve(sessionsDir, `${name}.session.json`);
export const callsPath = (name: string) => resolve(sessionsDir, `${name}.calls.json`);
