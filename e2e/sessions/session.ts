import { resolve } from "node:path";

/**
 * One thing that happened in a wrapped program. `elapse_nanosecond` is the nanoseconds elapsed since the test started (performance API).
 * `command` opens each call with the arguments the program got; `stdin`, `stdout` and `stderr` carry a `chunk`.
 */
export type SessionEntry =
  | { elapse_nanosecond: number; type: "command"; args: string[] }
  | { elapse_nanosecond: number; type: "stdin" | "stdout" | "stderr"; chunk: string };

/** How a wrapped program was called and how it ended; one per call, in the order the calls started. */
export interface SessionCall {
  program: string;
  argv: string[];
  exitCode: number | null;
}

export const sessionsDir = resolve(import.meta.dir, "__sessions__");
export const sessionPath = (name: string) => resolve(sessionsDir, `${name}.session.json`);
export const callsPath = (name: string) => resolve(sessionsDir, `${name}.calls.json`);
