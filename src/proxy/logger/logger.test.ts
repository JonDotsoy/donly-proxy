import { expect, test } from "bun:test";
import { createLogger_experimental } from "./logger";

/** A stream that collects every chunk written to it, decoded as `.ndjson` lines. */
const sink = () => {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({ write: (chunk) => void chunks.push(chunk) });
  const lines = () => Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { writable, lines, chunks };
};

const setup = () => {
  const { writable, lines, chunks } = sink();
  const Logger = createLogger_experimental(writable);
  const transaction = Logger.request.openTransaction({
    method: "POST",
    url: "http://example.com/a?b=1",
    httpVersion: "1.1",
    headers: { host: "example.com" },
    body: Buffer.from("ping"),
  });
  // Every call is read back after the stream accepted its lines.
  return { Logger, chunks, transaction, lines: async () => (await Logger.flush(), lines()) };
};

const reply = { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("pong") };
const logs = [{ type: "stdout" as const, timestamp: "2026-10-15T00:00:00.000Z", message: "out" }];

test("request.openTransaction writes the request with the common fields and a span id", async () => {
  const { lines, transaction } = setup();
  const [request] = await lines();
  expect(request).toMatchObject({ type: "request", http_version: "HTTP/1.1", method: "POST", url: "http://example.com/a?b=1", payload: "ping", transaction_id: transaction.transactionId, span_id: transaction.spanId });
  expect(typeof request.timestamp).toBe("string");
  expect(typeof request.performance_timestamp).toBe("number");
  expect(request).not.toHaveProperty("parent_span_id");
});

test("annotation writes request_annotation on the request and annotation on a command", async () => {
  const { lines, transaction } = setup();
  transaction.annotation({ foo: "tar" });
  const command = transaction.command.openTransaction({ program: "curl", args: ["-s"] });
  command.annotation({ bar: 1 });
  const [, onRequest, , onCommand] = await lines();
  expect(onRequest).toMatchObject({ type: "request_annotation", span_id: transaction.spanId, annotation: { foo: "tar" } });
  expect(onCommand).toMatchObject({ type: "annotation", span_id: command.spanId, parent_span_id: transaction.spanId, annotation: { bar: 1 } });
});

test("nested commands link each child to its parent and end with their own span", async () => {
  const { lines, transaction } = setup();
  const kubectl = transaction.command.openTransaction({ program: "kubectl", args: ["exec", "-i", "pod/api-0", "--", "node", "-"] });
  const node = kubectl.command.openTransaction({ program: "node", args: ["-"] });
  node.script.openTransaction({ script: "console.log(1)" });
  node.end(0, logs);
  kubectl.end(0, logs);
  transaction.response(reply);

  const all = await lines();
  expect(all.map((line) => `${line.type}${line.program ? `:${line.program}` : ""}`)).toEqual([
    "request", "command_start:kubectl", "command_start:node", "script:node", "command_end:node", "script_exit:node", "command_end:kubectl", "response",
  ]);
  const [, kubectlStart, nodeStart, script, nodeEnd, , kubectlEnd, response] = all;
  expect(kubectlStart).toMatchObject({ parent_span_id: transaction.spanId, args: ["exec", "-i", "pod/api-0", "--", "node", "-"], command: ["kubectl", "exec", "-i", "pod/api-0", "--", "node", "-"] });
  expect(nodeStart.parent_span_id).toBe(kubectlStart.span_id);
  expect(script).toMatchObject({ parent_span_id: nodeStart.span_id, script: "console.log(1)" });
  expect(nodeEnd).toMatchObject({ span_id: nodeStart.span_id, parent_span_id: kubectlStart.span_id, exit_code: 0, console_log: logs });
  expect(kubectlEnd).toMatchObject({ span_id: kubectlStart.span_id, parent_span_id: transaction.spanId });
  expect(response).toMatchObject({ span_id: transaction.spanId, status: 200, payload: "pong" });
  expect(new Set(all.map((line) => line.transaction_id)).size).toBe(1);
});

test("proxyPass writes request_proxy_pass and response_proxy_pass as a child of the request", async () => {
  const { lines, transaction } = setup();
  const upstream = transaction.proxyPass.openTransaction({ method: "POST", target: "http://up.test/a?b=1", headers: { "x-custom": "1" }, body: Buffer.from("ping") });
  upstream.end({ status: 201, headers: { "content-type": "text/plain" }, body: Buffer.from("created") });
  upstream.end({ status: 500, headers: {}, body: Buffer.alloc(0) });
  transaction.response(reply);
  const all = await lines();
  expect(all.map((line) => line.type)).toEqual(["request", "request_proxy_pass", "response_proxy_pass", "response"]);
  const [, start, end] = all;
  expect(start).toMatchObject({ span_id: upstream.spanId, parent_span_id: transaction.spanId, target: "http://up.test/a?b=1", headers: { "x-custom": "1" }, payload: "ping" });
  expect(end).toMatchObject({ span_id: upstream.spanId, parent_span_id: transaction.spanId, status: 201, payload: "created" });
});

test("end writes only once", async () => {
  const { lines, transaction } = setup();
  const command = transaction.command.openTransaction({ program: "curl", args: [] });
  command.end(0, []);
  command.end(1, []);
  expect((await lines()).filter((line) => line.type === "command_end")).toHaveLength(1);
});

test("ending a parent first closes its open children with a null exit code", async () => {
  const { lines, transaction } = setup();
  const parent = transaction.command.openTransaction({ program: "kubectl", args: [] });
  const child = parent.command.openTransaction({ program: "node", args: [] });
  parent.end(null, []);
  const ends = (await lines()).filter((line) => line.type === "command_end");
  expect(ends.map((line) => line.span_id)).toEqual([child.spanId, parent.spanId]);
  expect(ends.every((line) => line.exit_code === null)).toBe(true);
});

test("response closes the commands left open", async () => {
  const { lines, transaction } = setup();
  const command = transaction.command.openTransaction({ program: "curl", args: [] });
  transaction.response({ ...reply, command: ["curl"] });
  const all = await lines();
  expect(all.map((line) => line.type)).toEqual(["request", "command_start", "command_end", "response"]);
  expect(all[2]).toMatchObject({ span_id: command.spanId, exit_code: null, console_log: [] });
  expect(all[3].command).toEqual(["curl"]);
});

test("non-utf8 payloads are logged in base64", async () => {
  const { lines, transaction } = setup();
  transaction.response({ ...reply, body: Buffer.from([0xff, 0xfe]) });
  expect((await lines())[1]).toMatchObject({ type: "response", payload: "//4=", payload_encoding: "base64" });
});

test("listening writes the real host and port", async () => {
  const { Logger, lines } = setup();
  Logger.listening("127.0.0.1", 8080);
  expect((await lines()).at(-1)).toMatchObject({ type: "listening", host: "127.0.0.1", port: 8080 });
});

test("every line is a utf8 chunk ending in a newline", async () => {
  const { Logger, chunks, transaction } = setup();
  transaction.response(reply);
  await Logger.flush();
  expect(chunks).toHaveLength(2);
  for (const chunk of chunks) {
    expect(chunk).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(chunk).endsWith("\n")).toBe(true);
  }
});

test("a failing stream does not make the logger throw", async () => {
  const Logger = createLogger_experimental(new WritableStream<Uint8Array>({ write: () => Promise.reject(new Error("disk full")) }));
  const transaction = Logger.request.openTransaction({ method: "GET", url: "http://x.test/", httpVersion: "1.1", headers: {}, body: Buffer.alloc(0) });
  transaction.response(reply);
  await Logger.flush();
});
