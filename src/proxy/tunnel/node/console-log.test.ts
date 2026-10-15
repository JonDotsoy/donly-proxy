import { afterAll, beforeAll, expect } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "../../server";
import { testFeature } from "../../../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-node-console-"));
const bin = join(dir, "bin");
const logFile = join(dir, "proxy.ndjson");
const realNode = Bun.which("node");
if (!realNode) throw new Error("node is required for these tests");

// A `node` wrapper that writes a warning to stderr and then runs the real node.
mkdirSync(bin);
writeFileSync(join(bin, "node"), `#!/bin/sh\necho "wrapper warning" >&2\nexec "${realNode}" "$@"\n`);
chmodSync(join(bin, "node"), 0o755);

const upstream = http.createServer((_req, res) => res.end("from upstream"));

const manifestPayload = (port: number) => `proxy {
  host "127.0.0.1"
  port 0
  log_file "./proxy.ndjson"
  route http://127.0.0.1:${port}/ {
    command_pass node
  }
}
`;
const payload = manifestPayload(8080);

const saved = { PATH: process.env.PATH, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
let server: http.Server;
let proxy: string;
let port: number;

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  port = (upstream.address() as AddressInfo).port;
  writeFileSync(join(dir, "manifest.donly"), manifestPayload(port));
  process.env.NO_PROXY = process.env.no_proxy = "";
  process.env.PATH = `${bin}${delimiter}${saved.PATH}`;
  server = createProxyServer(await loadConfig(join(dir, "manifest.donly")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  process.env.PATH = saved.PATH;
  for (const [key, value] of [["NO_PROXY", saved.NO_PROXY], ["no_proxy", saved.no_proxy]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  server.close();
  upstream.close();
});

testFeature(
  payload,
  ["/proxy/log_file", "/proxy/route/command_pass"],
  "command_pass node logs its console in command_exit without changing the response",
  async () => {
    const before = readFileSync(logFile, "utf8").split("\n").filter(Boolean).length;
    const res = await fetch(`http://127.0.0.1:${port}/x`, { proxy });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from upstream");
    const lines = readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(before).map((line) => JSON.parse(line));
    const exit = lines.find((line) => line.type === "command_exit");
    expect(exit).toMatchObject({ program: "node", exit_code: 0 });
    const log = exit.console_log as { type: string; message: string }[];
    const stdin = log.find((entry) => entry.type === "stdin");
    expect(stdin?.message).toContain("globalThis.__donlyRequest");
    const stdout = log.filter((entry) => entry.type === "stdout").map((entry) => entry.message).join("");
    expect(JSON.parse(stdout)).toMatchObject({ status: 200, body: Buffer.from("from upstream").toString("base64") });
    expect(log.filter((entry) => entry.type === "stderr").map((entry) => entry.message).join("")).toContain("wrapper warning");
    // The response line does not carry the console.
    expect(lines.find((line) => line.type === "response")).not.toHaveProperty("console_log");
  },
);
