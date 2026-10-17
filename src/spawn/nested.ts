import { randomUUID } from "node:crypto";
import { ShellResponse, type ShellRequest } from "./shell";

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Runs the requests inside the shell behind `shell`, one at a time. The shell must read commands from
 * its stdin (`shellRequest.stdin`, the response has no input). It takes over `shell.stdout`; the stderr of a nested process is delivered after its stdout, once it ends.
 */
export const nestedSpawner = (shell: ShellResponse, shellRequest: ShellRequest) => {
  const shellStdin = shellRequest.stdin;
  if (!shellStdin) throw new TypeError("the shell has no stdin: create its request with a stdin to run nested processes");
  const reader = shell.stdout.getReader();
  let pending = "";
  let ended = false;
  let tail: Promise<unknown> = Promise.resolve();

  // Reads more output of the shell as latin1, so every byte survives the round trip.
  const fill = async () => {
    const { done, value } = await reader.read();
    if (done) ended = true;
    else pending += Buffer.from(value).toString("latin1");
    return !done;
  };

  const send = async (script: string) => {
    const writer = shellStdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(`${script}\n`));
    } finally {
      writer.releaseLock();
    }
  };

  /** Waits for the line `<marker><digits>` and returns what came before it and the digits. */
  const until = async (marker: string, onData?: (data: string) => void) => {
    const line = new RegExp(`${marker}(\\d*)\\r?\\n`);
    for (;;) {
      const match = line.exec(pending);
      if (match) {
        onData?.(pending.slice(0, match.index));
        pending = pending.slice(match.index + match[0].length);
        return match[1]!;
      }
      // Hold back what may be the start of the marker.
      const safe = pending.length - marker.length;
      if (safe > 0) {
        onData?.(pending.slice(0, safe));
        pending = pending.slice(safe);
      }
      if (!(await fill())) throw new Error("the shell closed before the nested process finished");
    }
  };

  const mark = (name: string) => `__DONLY_${name}_${randomUUID().replaceAll("-", "")}__`;
  // `printf '%s%d' 'A' x` joins the pieces, so the echo of the command never contains the marker followed by digits.
  const print = (marker: string, value: string) => `printf '%s%d\\n' ${quote(marker)} ${value}`;

  const ready = (async () => {
    // Without readline echo, prompts and line editing the output of the shell is only the output of the commands.
    const marker = mark("INIT");
    await send(`set +o emacs 2>/dev/null; set +o vi 2>/dev/null; stty -echo 2>/dev/null; PS1=; PS2=; ${print(marker, "0")}`);
    await until(marker);
  })();
  ready.catch(() => {});

  return async (request: ShellRequest): Promise<ShellResponse> => {
    const turn = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => (release = resolve));
    try {
      await turn;
      await ready;
      const pidMarker = mark("PID");
      const errMarker = mark("ERR");
      const endMarker = mark("END");
      const inner = [
        print(pidMarker, '"$BASHPID"'),
        ...(request.cwd ? [`cd ${quote(request.cwd)} || exit 1`] : []),
        `exec ${request.env ? `env ${Object.entries(request.env).map(([k, v]) => quote(`${k}=${v}`)).join(" ")} ` : ""}${request.commands.map(quote).join(" ")}`,
      ].join("; ");
      // The input travels as base64 in the script (bash reads the script from its stdin, so there is no argument limit).
      const input = request.input ? Buffer.from(await new Response(request.input).arrayBuffer()) : undefined;
      const stdin = input?.length ? `< <(printf '%s' ${quote(input.toString("base64"))} | base64 -d)` : "</dev/null";
      // stderr goes to a file and is printed after stdout, between the markers.
      await send(
        `e=$(mktemp); ( ${inner} ) ${stdin} 2>"$e"; c=$?; ${print(errMarker, "0")}; cat "$e"; rm -f "$e"; ${print(endMarker, "$c")}`,
      );
      const pid = Number(await until(pidMarker));

      const stream = () => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const readable = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
        return { readable, controller };
      };
      const out = stream();
      const err = stream();
      const enqueueTo = (target: ReadableStreamDefaultController<Uint8Array>) => (data: string) => {
        if (data) target.enqueue(Buffer.from(data, "latin1"));
      };
      const exitCode = (async () => {
        await until(errMarker, enqueueTo(out.controller));
        out.controller.close();
        const code = await until(endMarker, enqueueTo(err.controller));
        err.controller.close();
        return Number(code);
      })().then(
        (code) => {
          release();
          return code;
        },
        (error) => {
          out.controller.error(error);
          err.controller.error(error);
          release();
          throw error;
        },
      );
      exitCode.catch(() => {});
      return new ShellResponse({ pid, exitCode, stdout: out.readable, stderr: err.readable });
    } catch (error) {
      release();
      throw error;
    }
  };
};
