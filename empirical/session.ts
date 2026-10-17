import { resolve } from "node:path";

/**
 * One thing that happened in a wrapped program. `elapse_nanosecond` is the nanoseconds elapsed since the scenario started (performance API),
 * the same origin for every session of the scenario.
 * `session` opens the file once with the id, the ISO `timestamp` of the start, the `name` of the scenario and the scenario it belongs to
 * (`parent_session_id` is the session of the wrapped program that started this one, `null` when the scenario script did);
 * `command` opens each call with the program that ran and the arguments it got; `stdin`, `stdout` and `stderr` carry a `chunk`,
 * and `end` closes it with the `exit_code`.
 */
export type SessionEntry =
  | { elapse_nanosecond: number; type: "session"; id: string; timestamp: string; name: string; scenario_id: string; parent_session_id: string | null; summary?: string }
  | { elapse_nanosecond: number; type: "command"; command: string; args: string[] }
  | { elapse_nanosecond: number; type: "stdin" | "stdout" | "stderr"; chunk: string }
  | { elapse_nanosecond: number; type: "end"; exit_code: number | null };

export const scenariosDir = resolve(import.meta.dir, "__scenarios__");

/** Throws when `entries` is not a well-formed session: one `session` first, then calls that open with `command`, carry chunks and close with `end`, in time order. */
export const validateSession = (entries: SessionEntry[]) => {
  if (!Array.isArray(entries)) throw new Error("a session is an array of entries");
  const first = entries[0];
  if (first?.type !== "session") throw new Error("a session opens with a `session` entry");
  if (entries.filter((entry) => entry.type === "session").length !== 1) throw new Error("a session has exactly one `session` entry");
  let inCall = false;
  let previous = 0;
  for (const entry of entries) {
    if (!Number.isInteger(entry.elapse_nanosecond) || entry.elapse_nanosecond < 0) throw new Error("elapse_nanosecond must be a non-negative integer");
    if (entry.elapse_nanosecond < previous) throw new Error("entries must be in time order");
    previous = entry.elapse_nanosecond;
    if (entry.type === "session") {
      if (new Date(entry.timestamp).toISOString() !== entry.timestamp) throw new Error("timestamp must be an ISO date");
    } else if (entry.type === "command") {
      if (inCall) throw new Error("a command cannot open before the previous call has its end");
      inCall = true;
      if (typeof entry.command !== "string" || !Array.isArray(entry.args) || !entry.args.every((arg) => typeof arg === "string")) throw new Error("command needs a string command and string args");
    } else if (entry.type === "end") {
      if (!inCall) throw new Error("an end needs the command it closes");
      inCall = false;
      if (entry.exit_code !== null && !Number.isInteger(entry.exit_code)) throw new Error("exit_code must be an integer or null");
    } else if (entry.type === "stdin" || entry.type === "stdout" || entry.type === "stderr") {
      if (!inCall) throw new Error(`${entry.type} chunks belong between a command and its end`);
      if (typeof entry.chunk !== "string") throw new Error("chunk must be a string");
    } else {
      throw new Error(`unknown entry type ${(entry as { type: string }).type}`);
    }
  }
  if (inCall) throw new Error("every command needs its end");
};
