import type { Engine } from "../tunnel/remote";
import type { CurlRequest, CurlResponse } from "../tunnel/types";

/** What a plugin receives once, when its route is set up. */
export interface StartOptions {
  /** Arguments of the line after the plugin name (`ssh` / `kubectl`: options, then the target last). */
  args: string[];
  /** Engine that runs remotely (`ssh`, `kubectl`). */
  engine?: Engine;
  /** Extra options for the remote engine. */
  engineArgs?: string[];
  /** `kubectl_pass … { pod_match … }`. */
  podMatch?: { glob: string; selectors: string[] };
  /** Password for `ssh` (`ssh_pass … { pass … }`). */
  password?: string;
}

/** What a plugin receives with every request: callbacks that feed the transaction log. */
export interface RequestContext extends Pick<CurlRequest, "onCommand" | "onScript" | "onConsole" | "onExit" | "onLookup"> {
  /** Opens the log lines of an upstream HTTP call; `end` closes them with the reply. */
  upstream?: (call: { method: string; target: string; headers: Record<string, string>; body: Buffer }) => {
    end: (reply: { status: number; headers: Record<string, string | string[]>; body: Buffer }) => void;
  };
}

export interface CommandPassInit {
  start(options: StartOptions): void | Promise<void>;
  request(request: Request, context: RequestContext): Promise<Response>;
}

/** A `command_pass` plugin. Like a `ReadableStream` source, its state lives in the closure that builds it. */
export class CommandPass {
  constructor(private readonly init: CommandPassInit) {}

  start(options: StartOptions) {
    return this.init.start(options);
  }

  request(request: Request, context: RequestContext = {}) {
    return this.init.request(request, context);
  }
}

/** Headers that never travel from the client to the upstream, nor back. */
export const hopByHop = new Set([
  "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer",
  "host", "content-length",
]);

/** Builds a `Response` from the parts of a tunnel reply (an empty body stays `null`: 204 and 304 have none). */
export const toResponse = ({ status, headers, body }: CurlResponse) => {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) out.append(name, item);
  }
  return new Response(body.length > 0 ? new Uint8Array(body) : null, { status, headers: out });
};

/** Adapts a function that runs a request outside the process (curl, node, ssh, kubectl) into a plugin factory. */
export const tunnelPlugin = (run: (request: CurlRequest, options: StartOptions) => Promise<CurlResponse>) => () => {
  let options: StartOptions = { args: [] };
  return new CommandPass({
    start(given) {
      options = given;
    },
    async request(request, context) {
      const headers: Record<string, string> = {};
      // curl negotiates the encoding itself (`--compressed`).
      for (const [name, value] of request.headers) if (!hopByHop.has(name) && name !== "accept-encoding") headers[name] = value;
      const tunnel: CurlRequest = {
        method: request.method,
        url: request.url,
        headers,
        body: Buffer.from(await request.arrayBuffer()),
        args: options.args,
        engineArgs: options.engineArgs,
        podMatch: options.podMatch,
        password: options.password,
        ...context,
      };
      return toResponse(await run(tunnel, options));
    },
  });
};
