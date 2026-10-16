import { ShellRequest, spawn, type SpawnLogger, type SystemSpawn } from "../../spawn";
import type { ConsoleEntry } from "./types";

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

/** Collects a stream, reporting every piece to `onChunk`. */
const collect = async (stream: ReadableStream<Uint8Array>, onChunk: (chunk: Buffer) => void) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    chunks.push(buffer);
    onChunk(buffer);
  }
  return Buffer.concat(chunks);
};

/** Runs a command (no shell), feeds `input` to its stdin and collects its output. */
export const run = async (
  command: string,
  argv: string[],
  input: Buffer | string,
  onCommand?: (command: string[]) => void,
  /** Extra environment variables for the process (secrets go here, never in `argv`). */
  env?: Record<string, string>,
  onExit?: (code: number | null) => void,
  onConsole?: (entry: ConsoleEntry) => void,
  /** Where the command runs: by default a child process of this one. */
  system?: SystemSpawn,
  /** Writes the process to the `.ndjson` log (`command_start` / `command_end`). */
  logger?: SpawnLogger,
): Promise<RunResult> => {
  onCommand?.([command, ...argv]);
  const entry = (type: ConsoleEntry["type"], message: string) =>
    onConsole?.({ type, timestamp: new Date().toISOString(), message });
  const request = new ShellRequest({ commands: [command, ...argv], stdin: new WritableStream(), env });
  // The input is written while the command starts: a nested system reads all of it before it runs the command.
  entry("stdin", input.toString());
  const writer = request.stdin!.getWriter();
  // Not awaited: the command may print before it has read all of its input.
  writer.write(typeof input === "string" ? new TextEncoder().encode(input) : input).then(() => writer.close()).catch(() => {});
  const response = await spawn(request, { system, logger });
  const [stdout, stderr, code] = await Promise.all([
    collect(response.stdout, (chunk) => entry("stdout", chunk.toString())),
    collect(response.stderr, (chunk) => entry("stderr", chunk.toString())),
    response.exitCode,
  ]);
  onExit?.(code);
  return { code, stdout, stderr };
};
