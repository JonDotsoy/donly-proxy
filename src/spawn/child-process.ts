import { spawn } from "node:child_process";
import { constants } from "node:os";
import { Readable, Writable } from "node:stream";
import { ShellResponse, SignalError, type ShellRequest } from "./shell";

const emptyStream = () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });

const exitCodeOf = (code: number | null, signal: NodeJS.Signals | null) =>
  code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);

const onAbort = ({ signal }: ShellRequest, fallback: NodeJS.Signals, kill: (signal: NodeJS.Signals) => void) => {
  if (!signal) return;
  const end = () => kill(signal.reason instanceof SignalError ? signal.reason.signal : fallback);
  if (signal.aborted) end();
  else signal.addEventListener("abort", end, { once: true });
};

/** Runs the request as a child process of this process. */
export const spawnChildProcess = async (request: ShellRequest): Promise<ShellResponse> => {
  if (request.tty) return spawnWithTerminal(request);
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
  onAbort(request, "SIGTERM", (signal) => child.kill(signal));
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

// Bun only: node has no pseudo terminal support. The terminal merges stdout and stderr.
const spawnWithTerminal = async (request: ShellRequest): Promise<ShellResponse> => {
  if (typeof Bun === "undefined") throw new Error("tty requires Bun");
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start: (controller) => void (output = controller) });
  const child = Bun.spawn(request.commands, {
    cwd: request.cwd,
    env: request.env && { ...process.env, ...request.env },
    terminal: { cols: 80, rows: 24, data: (_terminal: unknown, data: Uint8Array) => {
        // Late data after the exit is dropped.
        try {
          output.enqueue(data.slice());
        } catch {}
      } },
  } as Bun.SpawnOptions.OptionsObject<any, any, any>);
  onAbort(request, "SIGHUP", (signal) => child.kill(signal));
  const terminal = (child as unknown as { terminal: { write(data: string | Uint8Array): void } }).terminal;
  const exitCode = child.exited.then((code) => {
    output.close();
    return code;
  });
  request.input!
    .pipeTo(
      new WritableStream<Uint8Array>({
        write: (chunk) => void terminal.write(chunk),
        // A terminal has no end of input: closing it hangs the process up, as a closed terminal would.
        close: () => void child.kill("SIGHUP"),
      }),
    )
    .catch(() => {});
  return new ShellResponse({ pid: child.pid, exitCode, stdout, stderr: emptyStream(),
    stdin: request.stdin,
  });
};
