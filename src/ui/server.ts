import { createServer, type Server, type ServerResponse } from "node:http";
import { closeSync, existsSync, openSync, readSync, statSync, unwatchFile, watchFile } from "node:fs";
import page from "./index.html" with { type: "text" };

/** How many existing log lines a new browser receives before the live ones. */
const HISTORY_LINES = 200;
const POLL_MS = 100;
/** Only this many trailing bytes of the log are read to replay the history. */
const HISTORY_BYTES = 256 * 1024;
const KEEPALIVE_MS = 15_000;

const readRange = (file: string, start: number, end: number): string => {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
};

const completeLines = (text: string) => text.split("\n").filter(Boolean);

/** The last `HISTORY_LINES` complete lines before `end`, without reading the whole file. */
const lastLines = (file: string, end: number): string[] => {
  const start = Math.max(0, end - HISTORY_BYTES);
  const lines = completeLines(readRange(file, start, end));
  // A read that starts mid-file begins inside a line: drop that partial one.
  return (start > 0 ? lines.slice(1) : lines).slice(-HISTORY_LINES);
};

/**
 * HTTP server with a single-page view of the `.ndjson` log: `GET /` serves the page and
 * `GET /events` streams every log line as a Server-Sent Event (the last lines first, then the
 * new ones as the file grows).
 */
export const createUiServer = (logFile: string): Server => {
  const clients = new Set<ServerResponse>();
  // Bytes of the log already delivered; only complete lines (up to a "\n") are consumed.
  let offset = 0;

  const send = (res: ServerResponse, line: string) => res.write(`data: ${line}\n\n`);

  const poll = () => {
    if (!existsSync(logFile)) return;
    const size = statSync(logFile).size;
    if (size < offset) offset = 0; // truncated or rotated
    if (size === offset) return;
    const chunk = readRange(logFile, offset, size);
    const end = chunk.lastIndexOf("\n") + 1;
    if (end === 0) return;
    offset += Buffer.byteLength(chunk.slice(0, end));
    for (const line of completeLines(chunk.slice(0, end))) for (const client of clients) send(client, line);
  };

  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page);
      return;
    }
    if (req.method === "GET" && pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      // Same tick as joining `clients`, so no line is lost or duplicated between history and live.
      poll();
      if (existsSync(logFile) && offset > 0) {
        for (const line of lastLines(logFile, offset)) send(res, line);
      }
      clients.add(res);
      res.write(": connected\n\n");
      res.on("close", () => clients.delete(res));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  let keepalive: ReturnType<typeof setInterval>;
  server.on("listening", () => {
    watchFile(logFile, { interval: POLL_MS }, poll);
    // Comment lines keep idle connections from being dropped by proxies and browsers.
    keepalive = setInterval(() => {
      for (const client of clients) client.write(": keepalive\n\n");
    }, KEEPALIVE_MS);
    keepalive.unref();
  });
  server.on("close", () => {
    unwatchFile(logFile, poll);
    clearInterval(keepalive);
    for (const client of clients) client.end();
  });
  return server;
};
