import { afterAll, beforeAll, expect } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "../../server";
import { testFeature } from "../../../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-curl-console-"));
const bin = join(dir, "bin");
const logFile = join(dir, "proxy.ndjson");

// A fake `curl` that answers like curl does with the proxy's flags.
mkdirSync(bin);
writeFileSync(
  join(bin, "curl"),
  `#!/bin/sh
cat > /dev/null
printf '200\\n{"content-type":["text/plain"]}' >&2
printf 'ok'
`,
);
chmodSync(join(bin, "curl"), 0o755);

const payload = `proxy {
  host "127.0.0.1"
  port 0
  log_file "./proxy.ndjson"
  route http://console.test/* {
    command_pass curl
  }
}
`;

const saved = { PATH: process.env.PATH, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
let server: Server;
let proxy: string;

beforeAll(async () => {
  writeFileSync(join(dir, "manifest.donly"), payload);
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

testFeature(
  payload,
  ["/proxy/log_file", "/proxy/route/command_pass"],
  "command_pass curl ends with command_end carrying exit_code and console_log",
  async () => {
    const res = await fetch("http://console.test/", { proxy });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    const lines = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const exit = lines.find((line) => line.type === "command_end");
    expect(exit).toMatchObject({ program: "curl", exit_code: 0 });
    expect(exit.console_log).toContainEqual({ type: "stdout", timestamp: expect.any(String), message: "ok" });
    expect(exit.console_log.some((e: { type: string }) => e.type === "stderr")).toBe(true);
    expect(lines.find((line) => line.type === "response")).not.toHaveProperty("console_log");
  },
);
