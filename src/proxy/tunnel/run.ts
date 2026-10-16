import { ShellRequest, spawn } from "../../spawn";
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
): Promise<RunResult> => {
  onCommand?.([command, ...argv]);
  const entry = (type: ConsoleEntry["type"], message: string) =>
    onConsole?.({ type, timestamp: new Date().toISOString(), message });
  const response = await spawn(new ShellRequest({ commands: [command, ...argv], data: input, env }));
  entry("stdin", input.toString());
  const [stdout, stderr, code] = await Promise.all([
    collect(response.stdout, (chunk) => entry("stdout", chunk.toString())),
    collect(response.stderr, (chunk) => entry("stderr", chunk.toString())),
    response.exitCode,
  ]);
  onExit?.(code);
  return { code, stdout, stderr };
};
