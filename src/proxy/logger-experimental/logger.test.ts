import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger_experimental } from "./logger";

const setup = () => {
  const file = join(mkdtempSync(join(tmpdir(), "donly-proxy-logger-")), "logs", "proxy.ndjson");
  const logger = new Logger_experimental(file);
  const lines = () => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const transaction = logger.request.openTransaction({
    method: "POST",
    url: "http://example.com/a?b=1",
    httpVersion: "1.1",
    headers: { host: "example.com" },
    body: Buffer.from("ping"),
  });
  return { file, logger, lines, transaction };
};

const reply = { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("pong") };
const logs = [{ type: "stdout" as const, timestamp: "2026-10-15T00:00:00.000Z", message: "out" }];

test("request.openTransaction writes the request with the common fields and a span id", () => {
  const { lines, transaction } = setup();
  const [request] = lines();
  expect(request).toMatchObject({ type: "request", http_version: "HTTP/1.1", method: "POST", url: "http://example.com/a?b=1", payload: "ping", transaction_id: transaction.transactionId, span_id: transaction.spanId });
  expect(typeof request.timestamp).toBe("string");
  expect(typeof request.performance_timestamp).toBe("number");
  expect(request).not.toHaveProperty("parent_span_id");
});

test("annotation writes request_annotation on the request and annotation on a command", () => {
  const { lines, transaction } = setup();
  transaction.annotation({ foo: "tar" });
  const command = transaction.command.openTransaction({ program: "curl", args: ["-s"] });
  command.annotation({ bar: 1 });
  const [, onRequest, , onCommand] = lines();
  expect(onRequest).toMatchObject({ type: "request_annotation", span_id: transaction.spanId, annotation: { foo: "tar" } });
  expect(onCommand).toMatchObject({ type: "annotation", span_id: command.spanId, parent_span_id: transaction.spanId, annotation: { bar: 1 } });
});

test("nested commands link each child to its parent and end with their own span", () => {
  const { lines, transaction } = setup();
  const kubectl = transaction.command.openTransaction({ program: "kubectl", args: ["exec", "-i", "pod/api-0", "--", "node", "-"] });
  const node = kubectl.command.openTransaction({ program: "node", args: ["-"] });
  node.script.openTransaction({ script: "console.log(1)" });
  node.end(0, logs);
  kubectl.end(0, logs);
  transaction.response(reply);

  const all = lines();
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

test("end writes only once", () => {
  const { lines, transaction } = setup();
  const command = transaction.command.openTransaction({ program: "curl", args: [] });
  command.end(0, []);
  command.end(1, []);
  expect(lines().filter((line) => line.type === "command_end")).toHaveLength(1);
});

test("ending a parent first closes its open children with a null exit code", () => {
  const { lines, transaction } = setup();
  const parent = transaction.command.openTransaction({ program: "kubectl", args: [] });
  const child = parent.command.openTransaction({ program: "node", args: [] });
  parent.end(null, []);
  const ends = lines().filter((line) => line.type === "command_end");
  expect(ends.map((line) => line.span_id)).toEqual([child.spanId, parent.spanId]);
  expect(ends.every((line) => line.exit_code === null)).toBe(true);
});

test("response closes the commands left open", () => {
  const { lines, transaction } = setup();
  const command = transaction.command.openTransaction({ program: "curl", args: [] });
  transaction.response({ ...reply, command: ["curl"] });
  const all = lines();
  expect(all.map((line) => line.type)).toEqual(["request", "command_start", "command_end", "response"]);
  expect(all[2]).toMatchObject({ span_id: command.spanId, exit_code: null, console_log: [] });
  expect(all[3].command).toEqual(["curl"]);
});

test("non-utf8 payloads are logged in base64", () => {
  const { lines, transaction } = setup();
  transaction.response({ ...reply, body: Buffer.from([0xff, 0xfe]) });
  expect(lines()[1]).toMatchObject({ type: "response", payload: "//4=", payload_encoding: "base64" });
});

test("listening writes the real host and port", () => {
  const { logger, lines } = setup();
  logger.listening("127.0.0.1", 8080);
  expect(lines().at(-1)).toMatchObject({ type: "listening", host: "127.0.0.1", port: 8080 });
});

test("without a log file every call is a no-op", () => {
  const logger = new Logger_experimental();
  const transaction = logger.request.openTransaction({ method: "GET", url: "http://x.test/", httpVersion: "1.1", headers: {}, body: Buffer.alloc(0) });
  const command = transaction.command.openTransaction({ program: "curl", args: [] });
  command.script.openTransaction({ script: "" });
  command.end(0, []);
  transaction.response(reply);
  logger.listening("127.0.0.1", 1);
  expect(existsSync(join(tmpdir(), "undefined"))).toBe(false);
});
