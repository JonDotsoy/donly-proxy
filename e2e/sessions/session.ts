import { resolve } from "node:path";

/**
 * One thing that happened in a wrapped program. `elapse_nanosecond` is the nanoseconds elapsed since the test started (performance API).
 * `session_start` opens the file once (elapse 0) with the id, the ISO `timestamp` of the start, and the `name` and `summary` of the session; `command` opens each call with the program that ran and the arguments it got; `stdin`, `stdout` and `stderr` carry a `chunk`, and `end` closes it with the `exit_code`.
 */
export type SessionEntry =
  | { elapse_nanosecond: number; type: "session_start"; id: string; timestamp: string; name: string; summary?: string }
  | { elapse_nanosecond: number; type: "command"; command: string; args: string[] }
  | { elapse_nanosecond: number; type: "stdin" | "stdout" | "stderr"; chunk: string }
  | { elapse_nanosecond: number; type: "end"; exit_code: number | null };

export const sessionsDir = resolve(import.meta.dir, "__sessions__");
export const sessionPath = (name: string) => resolve(sessionsDir, `${name}.session.json`);
