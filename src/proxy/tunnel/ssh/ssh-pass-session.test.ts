import { afterAll, beforeAll, expect } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "../../server";
import { testFeature } from "../../../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-ssh-pass-session-"));
const bin = join(dir, "bin");
const logFile = join(dir, "proxy.ndjson");

// A fake `ssh` that runs the remote command (`sh -s`) locally, as the remote login shell would, and a
// fake `curl` that answers with the url of its config file followed by the stdin it received.
mkdirSync(bin);
writeFileSync(join(bin, "ssh"), `#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n`);
writeFileSync(
  join(bin, "curl"),
  `#!/bin/sh
printf '200\\n{"content-type":["text/plain"]}' >&2
printf '%s|' "$(grep '^url' "$2")"
cat
`,
);
chmodSync(join(bin, "ssh"), 0o755);
chmodSync(join(bin, "curl"), 0o755);

const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  log_file "./proxy.ndjson"
  route http://session.test/* {
    ssh_pass myserver {
      idle_time 0.4
      command_pass curl
    }
  }
}
`;
const manifest = join(dir, "manifest.donly");
writeFileSync(manifest, manifestPayload);

const originalPath = process.env.PATH;
let server: Server;
let proxy: string;

beforeAll(async () => {
  process.env.PATH = `${bin}${delimiter}${originalPath}`;
  server = createProxyServer(await loadConfig(manifest));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  server.close();
});

const load = (payload: string) => {
  const file = join(dir, `v-${Math.random()}.donly`);
  writeFileSync(file, payload);
  return loadConfig(file);
};
const sshPass = (children: string) => `proxy {\n  route / {\n    ssh_pass myserver {\n${children}\n      command_pass curl\n    }\n  }\n}\n`;
const logged = () =>
  readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>)
    .filter((entry) => entry.program === "ssh" && entry.type !== "response");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

testFeature(
  manifestPayload,
  ["/proxy/route/ssh_pass/idle_time"],
  "should open ssh once, send the next requests as stdin to it and close it once when idle",
  async () => {
    const before = logged().length;
    const bodies: string[] = [];
    for (const [path, body] of [["one", "first"], ["two", "second"], ["three", ""]] as const) {
      const res = await fetch(`http://session.test/${path}`, { proxy, method: body ? "POST" : "GET", body: body || undefined });
      expect(res.status).toBe(200);
      bodies.push(await res.text());
    }
    // Each request got its own answer through the same process.
    expect(bodies).toEqual(['url = "http://session.test/one"|first', 'url = "http://session.test/two"|second', 'url = "http://session.test/three"|']);
    // Still open: nothing closed it between the calls.
    expect(logged().slice(before).map((entry) => entry.type)).toEqual(["command_start", "command_stdin", "command_stdin", "command_stdin"]);
    expect(logged().slice(before).map((entry) => entry.reused)).toEqual([undefined, false, true, true]);
    await sleep(900);
    const entries = logged().slice(before);
    expect(entries.filter((entry) => entry.type === "command_start")).toHaveLength(1);
    expect(entries.filter((entry) => entry.type === "command_end")).toEqual([expect.objectContaining({ exit_code: 0 })]);
    expect(entries.at(-1)!.type).toBe("command_end");
    // The command of the single ssh is the one that opened the session (`sh -s`), not one per request.
    expect(entries[0]!.command.at(-1)).toBe("sh -s");
    expect(entries[0]!.command).toContain("myserver");
  },
);

testFeature(manifestPayload, ["/proxy/route/ssh_pass/idle_time"], "should open a new ssh when the previous one has been idle for idle_time", async () => {
  const before = logged().length;
  await (await fetch("http://session.test/a", { proxy })).text();
  await sleep(900);
  expect(await (await fetch("http://session.test/b", { proxy })).text()).toBe('url = "http://session.test/b"|');
  await sleep(900);
  const types = logged().slice(before).map((entry) => entry.type);
  expect(types.filter((type) => type === "command_start")).toHaveLength(2);
  expect(types.filter((type) => type === "command_end")).toHaveLength(2);
});

testFeature(
  sshPass(`      idle_time 30`),
  ["/proxy/route/ssh_pass/idle_time"],
  "should read the idle_time of ssh_pass in seconds, 10 by default",
  async (payload) => {
    const [first] = (await load(payload)).routes;
    expect(first!.action).toMatchObject({ idleTime: 30 });
    const [other] = (await load(sshPass(""))).routes;
    expect(other!.action).toMatchObject({ idleTime: 10 });
  },
);

testFeature(sshPass(`      idle_time 0`), ["/proxy/route/ssh_pass/idle_time"], "should accept idle_time 0 in ssh_pass to run one ssh per request", async (payload) => {
  const [first] = (await load(payload)).routes;
  expect(first!.action).toMatchObject({ idleTime: 0 });
});

testFeature(sshPass(`      idle_time -1`), ["/proxy/route/ssh_pass/idle_time"], "should reject a negative idle_time in ssh_pass", async (payload) => {
  await expect(load(payload)).rejects.toThrow("idle_time debe ser un número de segundos mayor o igual a 0");
  await expect(load(sshPass(`      idle_time "10"`))).rejects.toThrow("idle_time debe ser un número de segundos");
});
