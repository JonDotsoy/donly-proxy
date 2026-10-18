import { resolve } from "node:path";
import type { RecordLine } from "@jondotsoy/binrec";

export type { RecordLine };

export const scenariosDir = resolve(import.meta.dir, "__scenarios__");

/** The text a session read (`stdin`) or wrote (`stdout`, `stderr`): the bytes of all its chunks, in order, decoded once (a character may be split between two chunks). */
export const sessionText = (lines: RecordLine[], type: "stdin" | "stdout" | "stderr") =>
  Buffer.concat(lines.flatMap((line) => (line.type === type ? [line.data !== null ? Buffer.from(line.data) : Buffer.from(line.data_base64 ?? "", "base64")] : []))).toString();

/** Throws when `lines` is not a well-formed binrec record: one `command` first, chunks and signals after it, one `end` last, in time order. */
export const validateSession = (lines: RecordLine[]) => {
  if (!Array.isArray(lines)) throw new Error("a session is an array of lines");
  const [first, ...rest] = lines;
  if (first?.type !== "command") throw new Error("a session opens with a `command` line");
  if (typeof first.command !== "string" || !Array.isArray(first.args) || !first.args.every((arg) => typeof arg === "string")) throw new Error("command needs a string command and string args");
  let previous = 0;
  rest.forEach((line, index) => {
    const at = Date.parse(line.timestamp);
    if (Number.isNaN(at)) throw new Error("timestamp must be an ISO date");
    if (at < previous) throw new Error("lines must be in time order");
    previous = at;
    if (line.type === "command") throw new Error("a session has exactly one `command` line");
    if (line.type === "end") {
      if (index !== rest.length - 1) throw new Error("the `end` line closes the session");
      if (!Number.isInteger(line.exitCode)) throw new Error("exitCode must be an integer");
    } else if (line.type === "stdin" || line.type === "stdout" || line.type === "stderr") {
      if (line.data !== null && typeof line.data !== "string") throw new Error("data must be a string or null");
    }
  });
};
