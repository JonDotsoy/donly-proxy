import { spawn } from "node:child_process";

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
) =>
  new Promise<RunResult>((resolve, reject) => {
    onCommand?.([command, ...argv]);
    const child = spawn(command, argv, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }));
  });
