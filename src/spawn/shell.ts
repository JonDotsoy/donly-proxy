export interface ShellRequestOptions {
  /** Program followed by its arguments. They are never interpreted by a shell. */
  commands: string[];
  /** When given, everything written to `request.stdin` is also written to this stream. */
  stdin?: WritableStream<Uint8Array>;
  env?: Record<string, string>;
  cwd?: string;
  /** Run the process attached to a pseudo terminal. */
  tty?: boolean;
}

export class ShellRequest {
  readonly commands: string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly tty: boolean;
  /** Writable side of the process input: write to it, and close it to end the input. */
  readonly stdin: WritableStream<Uint8Array>;
  /** Readable side of the process input, consumed by the system that runs the request. */
  readonly input: ReadableStream<Uint8Array>;

  /** Copies `request` overriding it with `extra`. The copy shares the input of the original unless `extra.stdin` is given. */
  constructor(request: ShellRequest, extra?: Partial<ShellRequestOptions>);
  constructor(options: ShellRequestOptions);
  constructor(source: ShellRequest | ShellRequestOptions, extra?: Partial<ShellRequestOptions>) {
    const base = source instanceof ShellRequest ? source : undefined;
    const options = { ...source, ...extra };
    const commands = extra?.commands ?? source.commands;
    if (!commands.length || !commands[0]) throw new TypeError("commands must start with the program to run");
    this.commands = [...commands];
    this.cwd = extra?.cwd ?? source.cwd;
    this.tty = extra?.tty ?? source.tty ?? false;
    const env = { ...source.env, ...extra?.env };
    this.env = source.env || extra?.env ? env : undefined;

    if (base && !extra?.stdin) {
      this.stdin = base.stdin;
      this.input = base.input;
      return;
    }
    const sink = options.stdin?.getWriter();
    const pipe = new TransformStream<Uint8Array, Uint8Array>({
      transform: async (chunk, controller) => {
        controller.enqueue(chunk);
        await sink?.write(chunk);
      },
      flush: () => sink?.close(),
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
  stdin: WritableStream<Uint8Array>;
}

export class ShellResponse {
  readonly pid: number;
  readonly exitCode: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdin: WritableStream<Uint8Array>;

  constructor(init: ShellResponseInit) {
    this.pid = init.pid;
    this.exitCode = init.exitCode;
    this.stdout = init.stdout;
    this.stderr = init.stderr;
    this.stdin = init.stdin;
  }
}
