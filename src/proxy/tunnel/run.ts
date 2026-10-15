import { spawn } from "node:child_process";
import type { ConsoleEntry } from "./types";

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

/** Runs a command (no shell), feeds `input` to its stdin and collects its output. */
export const run = (
  command: string,
  argv: string[],
  input: Buffer | string,
  onCommand?: (command: string[]) => void,
  /** Extra environment variables for the process (secrets go here, never in `argv`). */
  env?: Record<string, string>,
  onExit?: (code: number | null) => void,
  onConsole?: (entry: ConsoleEntry) => void,
) =>
  new Promise<RunResult>((resolve, reject) => {
    onCommand?.([command, ...argv]);
    const child = spawn(command, argv, { stdio: ["pipe", "pipe", "pipe"], env: env && { ...process.env, ...env } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk) => {
      out.push(chunk);
      onConsole?.({ type: "stdout", message: chunk.toString() });
    });
    child.stderr.on("data", (chunk) => {
      err.push(chunk);
      onConsole?.({ type: "stderr", message: chunk.toString() });
    });
    child.on("error", reject);
    child.stdin.on("error", () => {});
    onConsole?.({ type: "stdin", message: input.toString() });
    child.stdin.end(input);
    child.on("close", (code) => {
      onExit?.(code);
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
