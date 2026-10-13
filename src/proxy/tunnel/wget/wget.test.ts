import { expect } from "bun:test";
import { parseWgetResult, wgetRemote } from "./wget";
import { testFeature } from "../../../utils/test_utils/test-feature/test-feature";

// These tests exercise the wget engine directly; the manifest shows where it is configured.
const payload = `proxy {\n  route / {\n    command_pass ssh "user@remote.test" {\n      engine wget\n    }\n  }\n}\n`;
const features = ["/proxy/route/command_pass/engine"];

const request = (over: Partial<Parameters<typeof wgetRemote>[0]> = {}) => ({
  method: "GET",
  url: "http://example.com/a?b=1",
  headers: { "x-custom": "abc" },
  body: Buffer.alloc(0),
  args: [],
  ...over,
});
const result = (stderr: string, code = 0, stdout = "body") => ({ code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });

testFeature(payload, features, "a GET becomes a fixed wget command line with quoted values", () => {
  const { command, input } = wgetRemote(request());
  expect(command).toContain(`wget '-q' '-S' '-O' '-' '--header' 'x-custom: abc' 'http://example.com/a?b=1'`);
  expect(command).not.toContain("--post-file");
  expect(input).toEqual(Buffer.alloc(0));
});

testFeature(payload, features, "a body becomes a POST sent from a temporary file", () => {
  const { command, input } = wgetRemote(request({ method: "POST", body: Buffer.from("payload") }));
  expect(command).toContain(`--post-file "$d/b"`);
  expect(input.toString()).toBe("payload");
});

testFeature(payload, features, "request data cannot break out of the shell quoting", () => {
  const evil = `'; touch /tmp/pwned; echo '`;
  const { command } = wgetRemote(request({ url: `http://example.com/${evil}`, headers: { "x-custom": evil } }));
  expect(command).toContain(`'x-custom: '\\''; touch /tmp/pwned; echo '\\'''`);
  expect(() => wgetRemote(request({ headers: { "x-custom": "a\nb: c" } }))).toThrow("control characters");
});

testFeature(payload, features, "methods other than GET and POST are refused", () => {
  expect(() => wgetRemote(request({ method: "PUT" }))).toThrow("only supports GET and POST");
  expect(() => wgetRemote(request({ method: "DELETE", body: Buffer.from("x") }))).toThrow("only supports GET and POST");
  expect(() => wgetRemote(request({ method: "GET", body: Buffer.from("x") }))).toThrow("only supports GET and POST");
});

testFeature(payload, features, "the status and headers are read from the last response printed by -S", () => {
  const response = parseWgetResult(
    result(
      "  HTTP/1.1 302 Found\n  Location: /b\n  \n  HTTP/1.1 200 OK\n  X-Echo: yes\n  Set-Cookie: a=1\n  Set-Cookie: b=2\n  Content-Length: 4\n  \n",
    ),
  );
  expect(response.status).toBe(200);
  expect(response.headers).toEqual({ "x-echo": "yes", "set-cookie": ["a=1", "b=2"], "content-length": "4" });
  expect(response.body.toString()).toBe("body");
});

testFeature(payload, features, "a 4xx response keeps its status even though wget exits with an error", () => {
  const response = parseWgetResult(result("  HTTP/1.1 404 Not Found\nwget: server returned error: HTTP/1.1 404 Not Found\n", 1, ""));
  expect(response.status).toBe(404);
  expect(response.body.length).toBe(0);
});

testFeature(payload, features, "without a status line the failure is reported", () => {
  expect(() => parseWgetResult(result("wget: bad address 'nope'\n", 1, ""), "kubectl wget")).toThrow(
    "kubectl wget exited with 1: wget: bad address 'nope'",
  );
});
