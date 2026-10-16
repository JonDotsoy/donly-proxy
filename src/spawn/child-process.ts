import { spawn } from "node:child_process";
import { constants } from "node:os";
import { Readable, Writable } from "node:stream";
import { ShellResponse, SignalError, type ShellRequest } from "./shell";

const exitCodeOf = (code: number | null, signal: NodeJS.Signals | null) =>
  code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);

const onAbort = ({ signal }: ShellRequest, kill: (signal: NodeJS.Signals) => void) => {
  if (!signal) return;
  const end = () => kill(signal.reason instanceof SignalError ? signal.reason.signal : "SIGTERM");
  if (signal.aborted) end();
  else signal.addEventListener("abort", end, { once: true });
};

/** Runs the request as a child process of this process. */
export const spawnChildProcess = async (request: ShellRequest): Promise<ShellResponse> => {
  const [command, ...args] = request.commands;
  const child = spawn(command, args, {
    cwd: request.cwd,
    env: request.env && { ...process.env, ...request.env },
    stdio: "pipe",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const exitCode = new Promise<number>((resolve) =>
    child.once("close", (code, signal) => resolve(exitCodeOf(code, signal))),
  );
  child.stdin.on("error", () => {});
  onAbort(request, (signal) => child.kill(signal));
  if (request.input) request.input.pipeTo(Writable.toWeb(child.stdin)).catch(() => {});
  else child.stdin.end();
  return new ShellResponse({
    pid: child.pid!,
    exitCode,
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
    stdin: request.stdin,
  });
};
