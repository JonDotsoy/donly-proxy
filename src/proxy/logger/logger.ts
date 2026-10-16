import { randomUUID } from "node:crypto";

/** One piece of console traffic of a command, with the moment it happened. */
export interface ConsoleLogEntry {
  type: "stdout" | "stderr" | "stdin";
  timestamp: string;
  message: string;
}

export interface RequestInfo {
  method: string;
  url: string;
  httpVersion: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** User that authenticated the request or its tunnel (`auth basic`). */
  proxyUser?: string;
}

/** A refused attempt to authenticate against the proxy. */
export interface AuthFailureInfo {
  protocol: "http" | "connect" | "socks5";
  /** Name the client tried; the password is never logged. */
  user?: string;
  remoteAddress?: string;
}

export interface CommandInfo {
  program: string;
  args: string[];
}

export interface ResponseInfo {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  /** Command line executed to produce the reply (`command_pass` only). */
  command?: string[];
}

export interface ScriptInfo {
  script: string;
  /** Program that runs the script; defaults to the program of the command that carries it. */
  program?: string;
}

/** The request the proxy sends upstream (`proxy_pass`). */
export interface ProxyPassInfo {
  method: string;
  /** Upstream URL, after the path and query rules of `proxy_pass`. */
  target: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface ProxyPassTransaction {
  readonly spanId: string;
  /** Writes `proxy_pass_response` with what the upstream answered. Only the first call writes. */
  end(reply: Omit<ResponseInfo, "command">): void;
}

type Entry = Record<string, unknown>;

export interface Logger {
  listening(host: string, port: number): void;
  authFailed(info: AuthFailureInfo): void;
  readonly request: { openTransaction(request: RequestInfo): RequestTransaction };
  /** Resolves once every line written so far has been accepted by the stream. */
  flush(): Promise<void>;
}

/** Opens the line of a nested transaction and returns it. */
interface Spans {
  readonly command: { openTransaction(info: CommandInfo): CommandTransaction };
}

export interface CommandTransaction extends Spans {
  readonly transactionId: string;
  readonly spanId: string;
  annotation(data: Record<string, unknown>): void;
  readonly script: { openTransaction(info: ScriptInfo): void };
  /** Closes the command: `command_end` (plus `script_end` when it ran a script). Only the first call writes. */
  end(exitCode: number | null, logs: ConsoleLogEntry[]): void;
}

export interface RequestTransaction extends Spans {
  readonly transactionId: string;
  readonly spanId: string;
  annotation(data: Record<string, unknown>): void;
  readonly proxyPass: { openTransaction(info: ProxyPassInfo): ProxyPassTransaction };
  /** Writes `response`; commands still open are closed first, with a `null` exit code. */
  response(reply: ResponseInfo): void;
}

/** Credentials never reach the log. */
const redact = (headers: RequestInfo["headers"]) =>
  "proxy-authorization" in headers ? { ...headers, "proxy-authorization": "[redacted]" } : headers;

/** Payload as utf8 when lossless, base64 otherwise. */
const encodePayload = (body: Buffer) => {
  const utf8 = body.toString("utf8");
  return Buffer.from(utf8).equals(body)
    ? { payload: utf8 }
    : { payload: body.toString("base64"), payload_encoding: "base64" };
};

/**
 * Experimental logger with nested transactions (see docs/plans/logger-transacciones.md).
 * Not wired to the proxy yet. The system creates it over the stream that receives the `.ndjson`
 * lines (one JSON object per line, utf8): `const Logger = createLogger_experimental(writable)`.
 *
 * `transaction_id` is the id of the request and is shared by the whole tree; `span_id` is the id of
 * each open transaction and `parent_span_id` the one that opened it.
 */
export const createLogger_experimental = (writable: WritableStream<Uint8Array>): Logger => {
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let pending: Promise<unknown> = Promise.resolve();

  const write = (entry: Entry) => {
    // `timestamp` is the wall clock (ms); `performance_timestamp` is the exact moment from the Performance API.
    const line = JSON.stringify({ timestamp: new Date().toISOString(), performance_timestamp: performance.timeOrigin + performance.now(), ...entry }) + "\n";
    // The stream queues the chunks in call order; a failing sink must not crash the proxy.
    pending = writer.write(encoder.encode(line)).catch(() => {});
  };

  const openCommand = (transaction: Entry, parentSpanId: string, info: CommandInfo, open: Set<CommandTransaction>): CommandTransaction => {
    const spanId = randomUUID();
    const common = { ...transaction, span_id: spanId, parent_span_id: parentSpanId };
    write({ ...common, type: "command_start", program: info.program, args: info.args, command: [info.program, ...info.args] });
    const children = new Set<CommandTransaction>();
    let scriptProgram: string | undefined;
    let ended = false;
    const command: CommandTransaction = {
      transactionId: transaction.transaction_id as string,
      spanId,
      annotation: (annotation) => write({ ...common, type: "annotation", annotation }),
      command: { openTransaction: (child) => openCommand(transaction, spanId, child, children) },
      script: {
        openTransaction: ({ script, program = info.program }) => {
          scriptProgram = program;
          write({ ...transaction, type: "script_start", span_id: randomUUID(), parent_span_id: spanId, program, script });
        },
      },
      end: (exitCode, logs) => {
        if (ended) return;
        ended = true;
        // A child never outlives its parent.
        for (const child of [...children].reverse()) child.end(null, []);
        open.delete(command);
        write({ ...common, type: "command_end", program: info.program, exit_code: exitCode, console_log: logs });
        if (scriptProgram) write({ ...common, type: "script_end", program: scriptProgram, exit_code: exitCode, console_log: logs });
      },
    };
    open.add(command);
    return command;
  };

  return {
    listening: (host, port) => write({ type: "listening", host, port }),
    authFailed: (info) => write({ type: "auth_failed", scheme: "basic", protocol: info.protocol, user: info.user, remote_address: info.remoteAddress }),
    flush: async () => {
      await pending;
    },
    request: {
      openTransaction: (request) => {
        const transaction = {
          transaction_id: randomUUID(),
          http_version: `HTTP/${request.httpVersion}`,
          method: request.method,
          url: request.url,
        };
        const spanId = randomUUID();
        write({ ...transaction, type: "request", span_id: spanId, headers: redact(request.headers), ...(request.proxyUser === undefined ? {} : { proxy_user: request.proxyUser }), ...encodePayload(request.body) });
        const open = new Set<CommandTransaction>();
        return {
          transactionId: transaction.transaction_id,
          spanId,
          annotation: (annotation) => write({ ...transaction, type: "request_annotation", span_id: spanId, annotation }),
          command: { openTransaction: (info) => openCommand(transaction, spanId, info, open) },
          proxyPass: {
            openTransaction: (info) => {
              const proxyPassSpanId = randomUUID();
              const common = { ...transaction, span_id: proxyPassSpanId, parent_span_id: spanId, target: info.target };
              write({ ...common, type: "proxy_pass_request", headers: info.headers, ...encodePayload(info.body) });
              let ended = false;
              return {
                spanId: proxyPassSpanId,
                end: (reply) => {
                  if (ended) return;
                  ended = true;
                  write({ ...common, type: "proxy_pass_response", status: reply.status, headers: reply.headers, ...encodePayload(reply.body) });
                },
              };
            },
          },
          response: (reply) => {
            for (const command of [...open].reverse()) command.end(null, []);
            write({
              ...transaction,
              type: "response",
              span_id: spanId,
              status: reply.status,
              ...(reply.command && { command: reply.command }),
              headers: reply.headers,
              ...encodePayload(reply.body),
            });
          },
        };
      },
    },
  };
};
