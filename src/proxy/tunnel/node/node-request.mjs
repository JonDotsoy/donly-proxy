// Runs in a separate `node` process spawned by the proxy (`command_pass node`).
// Reads { method, url, headers, body (base64) } as JSON from stdin (or globalThis.__donlyRequest), performs the
// request with http.request / https.request and writes { status, headers, body (base64) }
// as JSON to stdout. Any failure goes to stderr with a non-zero exit code.
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

// Run through `ssh ... node -`, stdin is this script itself, so the request arrives
// in `globalThis.__donlyRequest` instead.
let input = globalThis.__donlyRequest;
if (!input) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  input = JSON.parse(Buffer.concat(chunks).toString());
}
const { method, url, headers, body } = input;

const target = new URL(url);
if (target.protocol !== "http:" && target.protocol !== "https:") {
  process.stderr.write(`unsupported protocol ${target.protocol}`);
  process.exit(1);
}
const payload = Buffer.from(body, "base64");
const request = (target.protocol === "https:" ? https : http).request(
  target,
  { method, headers: payload.length ? { ...headers, "content-length": payload.length } : headers },
  (res) => {
    const decoders = {
      gzip: zlib.createGunzip,
      "x-gzip": zlib.createGunzip,
      deflate: zlib.createInflate,
      br: zlib.createBrotliDecompress,
    };
    const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
    const decoder = decoders[encoding];
    const source = decoder ? res.pipe(decoder()) : res;
    const out = [];
    source.on("data", (chunk) => out.push(chunk));
    source.on("error", (error) => fail(error));
    source.on("end", () => {
      const responseHeaders = { ...res.headers };
      if (decoder) delete responseHeaders["content-encoding"];
      process.stdout.write(
        JSON.stringify({
          status: res.statusCode,
          headers: responseHeaders,
          body: Buffer.concat(out).toString("base64"),
        }),
      );
    });
  },
);
const fail = (error) => {
  process.stderr.write(error.message);
  process.exit(1);
};
request.on("error", fail);
request.end(payload);
