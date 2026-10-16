import { CommandPass, hopByHop } from "./command-pass";

/** Fetches `upstream` and describes the reply; a failure becomes a 502. */
export const fetchUpstream = async (upstream: URL, method: string | undefined, headers: Headers, body: Buffer | undefined) => {
  try {
    const response = await fetch(upstream, { method, headers, body, redirect: "manual" });
    // fetch has already decoded the body, so encoding/length no longer apply.
    return {
      status: response.status,
      headers: response.headers,
      body: Buffer.from(await response.arrayBuffer()),
      drop: (name: string) => hopByHop.has(name) || name === "content-encoding",
    };
  } catch (error) {
    return {
      status: 502,
      headers: new Headers({ "content-type": "text/plain" }),
      body: Buffer.from(`bad gateway: ${(error as Error).message}`),
      drop: () => false,
    };
  }
};

export type Upstream = Awaited<ReturnType<typeof fetchUpstream>>;

/** The headers of an upstream reply without the hop-by-hop ones and the decoded `content-encoding`. */
export const replyHeaders = (reply: Upstream) => {
  const out = new Headers();
  for (const [name, value] of reply.headers) if (!reply.drop(name)) out.append(name, value);
  return out;
};

/**
 * `proxy_pass`: forwards the request with a plain `fetch`. The original path and query are kept,
 * unless the target declares its own path, which then replaces the path.
 */
export const installProxy = () => {
  let target = new URL("http://invalid/");
  return new CommandPass({
    start({ args }) {
      target = new URL(String(args[0]));
    },
    async request(request, context) {
      const original = new URL(request.url);
      const upstream = new URL(target);
      if (upstream.pathname === "/") upstream.pathname = original.pathname;
      upstream.search = original.search;
      const headers = new Headers();
      for (const [name, value] of request.headers) if (!hopByHop.has(name)) headers.set(name, value);
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const body = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined;
      const log = context.upstream?.({
        method: request.method,
        target: upstream.toString(),
        headers: Object.fromEntries(headers),
        body: body ?? Buffer.alloc(0),
      });
      const reply = await fetchUpstream(upstream, request.method, headers, body);
      const out = replyHeaders(reply);
      log?.end({ status: reply.status, headers: Object.fromEntries(out), body: reply.body });
      return new Response(reply.body.length > 0 ? new Uint8Array(reply.body) : null, { status: reply.status, headers: out });
    },
  });
};
