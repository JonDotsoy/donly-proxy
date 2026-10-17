import { constants } from "node:os";

export interface ShellRequestOptions {
  /** Program followed by its arguments. They are never interpreted by a shell. */
  commands: string[];
  /**
   * Gives the process an input: what is written to `request.stdin` reaches the process, and closing it ends the input.
   * The process keeps its stdin open while the writable stays alive. Without it the request has no stdin and the
   * process gets the end of the input right away. Everything written to `request.stdin` is also written to this stream.
   */
  stdin?: WritableStream<Uint8Array>;
  /** Run the process attached to a pseudo terminal (Bun only). Defaults to `false`: stdin, stdout and stderr are pipes. */
  tty?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  /**
   * Aborting it ends the process with the signal of a `SignalError` reason, or by default with `SIGTERM`
   * (`SIGHUP` in a tty: shells ignore `SIGTERM`).
   */
  signal?: AbortSignal;
}

/** Name of the signal for a name, a signal number (`1`) or an exit code of a signalled process (`129` = 128 + 1). */
const signalName = (signal: NodeJS.Signals | number): NodeJS.Signals => {
  if (typeof signal === "string") return signal;
  const number = signal > 128 ? signal - 128 : signal;
  const name = (Object.keys(constants.signals) as NodeJS.Signals[]).find((key) => constants.signals[key] === number);
  if (!name) throw new RangeError(`unknown signal ${signal}`);
  return name;
};

/** Abort reason that picks the signal sent to the process: `controller.abort(new SignalError("SIGHUP"))` or `new SignalError(129)`. */
export class SignalError extends Error {
  readonly signal: NodeJS.Signals;

  constructor(signal: NodeJS.Signals | number) {
    const name = signalName(signal);
    super(`process ended by ${name}`);
    this.name = "SignalError";
    this.signal = name;
  }
}

/** Asserts that `val` starts with the program to run. */
export function assertCommands(val: string[]): asserts val is [string, ...string[]] {
  if (!val.length || !val[0]) throw new TypeError("commands must start with the program to run");
}

export class ShellRequest {

  readonly commands: [string, ...string[]];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  /** Whether the process runs attached to a pseudo terminal, where stdout and stderr come mixed through stdout. */
  readonly tty: boolean;
  /** Writable side of the process input. Only exists when `stdin` was given. */
  readonly stdin?: WritableStream<Uint8Array>;
  /** Readable side of the process input, consumed by the system that runs the request. */
  readonly input?: ReadableStream<Uint8Array>;

  /** Copies `request` overriding it with `extra`. The copy shares the input of the original unless `extra.stdin` is given. */
  constructor(request: ShellRequest, extra?: Partial<ShellRequestOptions>);
  constructor(options: ShellRequestOptions);
  constructor(source: ShellRequest | ShellRequestOptions, extra?: Partial<ShellRequestOptions>) {
    const base = source instanceof ShellRequest ? source : undefined;
    const options = { ...source, ...extra };
    const commands = extra?.commands ?? source.commands;
    const copy = [...commands];
    assertCommands(copy);
    this.commands = copy;
    this.cwd = extra?.cwd ?? source.cwd;
    this.signal = extra?.signal ?? source.signal;
    this.tty = extra?.tty ?? source.tty ?? false;
    const env = { ...source.env, ...extra?.env };
    this.env = source.env || extra?.env ? env : undefined;

    if (base && !extra?.stdin) {
      this.stdin = base.stdin;
      this.input = base.input;
      return;
    }
    if (!options.stdin) return;
    const sink = options.stdin.getWriter();
    const pipe = new TransformStream<Uint8Array, Uint8Array>({
      transform: async (chunk, controller) => {
        controller.enqueue(chunk);
        await sink.write(chunk);
      },
      flush: () => sink.close(),
    });
    this.stdin = pipe.writable;
    this.input = pipe.readable;
  }
}

export interface ShellResponseInit {
  pid: number;
  exitCode: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  /** The input of the process, used to run nested processes (see `SystemSpawn.fromResponse`). */
  stdin?: WritableStream<Uint8Array>;
}

/** Options of the `new ShellResponse(stdout, options)` form, like the `init` of a web `Response`. */
export interface ShellResponseOptions {
  /** Defaults to an empty stream. */
  stderr?: ReadableStream<Uint8Array>;
  /** Defaults to `0`. */
  exitCode?: number | Promise<number>;
  /** Defaults to `0`, as a synthetic response has no process. */
  pid?: number;
  stdin?: WritableStream<Uint8Array>;
}

export class ShellResponse {
  readonly pid: number;
  readonly exitCode: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdin?: WritableStream<Uint8Array>;

  /** Builds a response from a process description. */
  constructor(init: ShellResponseInit);
  /** Builds a synthetic response the way a web `Response` is built: `new ShellResponse(stdout, { stderr, exitCode })`. */
  constructor(stdout: ReadableStream<Uint8Array>, options?: ShellResponseOptions);
  constructor(source: ShellResponseInit | ReadableStream<Uint8Array>, options: ShellResponseOptions = {}) {
    if (source instanceof ReadableStream) {
      this.pid = options.pid ?? 0;
      this.exitCode = Promise.resolve(options.exitCode ?? 0);
      this.stdout = source;
      this.stderr = options.stderr ?? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
      this.stdin = options.stdin;
      return;
    }
    this.pid = source.pid;
    this.exitCode = source.exitCode;
    this.stdout = source.stdout;
    this.stderr = source.stderr;
    this.stdin = source.stdin;
  }

  /** Reads all of `stdout` and decodes it as UTF-8. Consumes the stream. */
  async text(): Promise<string> {
    const decoder = new TextDecoder();
    let result = "";
    for await (const chunk of this.stdout) result += decoder.decode(chunk, { stream: true });
    return result + decoder.decode();
  }

  /** Reads all of `stdout` and parses it as JSON. Consumes the stream. */
  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }
}
