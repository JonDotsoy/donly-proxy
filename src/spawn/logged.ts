import type { CommandInfo, CommandTransaction, ConsoleLogEntry } from "../proxy/logger";
import { ShellRequest, ShellResponse } from "./shell";

/** Where the requests of `spawn` are logged: each `ShellRequest` writes a `command_start` and a `command_end` line. */
export interface SpawnLogger {
  /** Transaction (the request, or another command) that the logged command hangs from. */
  parent: { command: { openTransaction(info: CommandInfo): CommandTransaction } };
  /**
   * Opens the transactions of `request`, outermost first. By default one command (`program` and `args` of the request).
   * Use it when the request carries another process (`kubectl exec … -- node -`) or a script. All of them
   * end with the same exit code and `console_log`, the innermost first.
   */
  open?: (request: ShellRequest) => CommandTransaction[];
}

const defaultOpen = (logger: SpawnLogger, request: ShellRequest) => {
  const [program, ...args] = request.commands;
  return [logger.parent.command.openTransaction({ program, args })];
};

/** Reads a stream to its end reporting every piece. */
const drain = async (stream: ReadableStream<Uint8Array>, onChunk: (chunk: Uint8Array) => void) => {
  for await (const chunk of stream) onChunk(chunk);
};

/** Runs `run` for `request` writing its transactions to the log, with everything the process reads and prints. */
export const spawnLogged = async (
  logger: SpawnLogger,
  request: ShellRequest,
  run: (request: ShellRequest) => Promise<ShellResponse>,
): Promise<ShellResponse> => {
  const transactions = (logger.open ?? ((r) => defaultOpen(logger, r)))(request);
  const logs: ConsoleLogEntry[] = [];
  const entry = (type: ConsoleLogEntry["type"]) => (chunk: Uint8Array) =>
    void logs.push({ type, timestamp: new Date().toISOString(), message: Buffer.from(chunk).toString() });
  const close = (code: number | null) => {
    for (const transaction of [...transactions].reverse()) transaction.end(code, logs);
  };

  try {
    let toRun = request;
    let stdinLogged: Promise<void> | undefined;
    if (request.input) {
      // A copy whose stdin also reports what is written; the original input is piped into it.
      toRun = new ShellRequest(request, {
        stdin: new WritableStream({ write: (chunk) => void entry("stdin")(chunk) }),
      });
      stdinLogged = request.input.pipeTo(toRun.stdin!).catch(() => {});
    }
    const response = await run(toRun);
    const [stdout, stdoutLog] = response.stdout.tee();
    const [stderr, stderrLog] = response.stderr.tee();
    const drained = Promise.all([drain(stdoutLog, entry("stdout")), drain(stderrLog, entry("stderr"))]);
    void (async () => {
      let code: number | null = null;
      try {
        code = await response.exitCode;
        await Promise.all([drained, stdinLogged]);
      } catch {
        code = null;
      }
      close(code);
    })();
    return new ShellResponse({ pid: response.pid, exitCode: response.exitCode, stdout, stderr, stdin: request.stdin });
  } catch (error) {
    entry("stderr")(new TextEncoder().encode(String((error as Error).message ?? error)));
    close(null);
    throw error;
  }
};
