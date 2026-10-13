import { afterAll, beforeAll, expect } from "bun:test";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-logscript-"));
const bin = join(dir, "bin");
const logFile = join(dir, "proxy.ndjson");

// Fake kubectl that answers like the `node` engine does (a JSON result on stdout).
mkdirSync(bin);
writeFileSync(join(bin, "kubectl"), `#!/bin/sh\ncat > /dev/null\nprintf '{"status":200,"headers":{},"body":""}'\n`);
chmodSync(join(bin, "kubectl"), 0o755);

const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  log_file "./proxy.ndjson"
  route {
    kubectl_pass "conn-pod" {
      command_pass node
    }
  }
}
`;
writeFileSync(join(dir, "manifest.donly"), manifestPayload);

const saved = { PATH: process.env.PATH, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
let server: ReturnType<typeof createProxyServer>;
let proxy: string;

beforeAll(async () => {
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
});

testFeature(manifestPayload, ["/proxy/log_file", "/proxy/route/kubectl_pass/command_pass"], "should log the script sent to node through stdin right after its command", async () => {
  const before = readFileSync(logFile, "utf8").split("\n").filter(Boolean).length;
  await (await fetch("http://logscript.test/path?x=1", { proxy, method: "POST", body: "payload" })).text();
  const lines = readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(before).map((line) => JSON.parse(line));
  const types = lines.map((line) => line.type);
  const script = lines.find((line) => line.type === "script");
  expect(script).toMatchObject({ program: "node" });
  // The script is the whole stdin: the request prelude and the code that performs it.
  expect(script.script).toContain("globalThis.__donlyRequest");
  expect(script.script).toContain("http");
  // The order: the kubectl and node commands, then their script.
  expect(types.indexOf("script")).toBe(types.lastIndexOf("command") + 1);
  expect(lines.find((line) => line.type === "request")).not.toHaveProperty("script");
});
