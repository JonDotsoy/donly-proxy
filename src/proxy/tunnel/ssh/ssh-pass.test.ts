import { afterAll, beforeAll, expect } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "../../server";
import { testFeature } from "../../../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-ssh-pass-"));
const bin = join(dir, "bin");
const argsFile = join(dir, "ssh.args");

// A fake `ssh` that records its arguments (NUL separated) and answers like the curl engine does.
mkdirSync(bin);
writeFileSync(
  join(bin, "ssh"),
  `#!/bin/sh
printf '%s\\0' "$@" > "${argsFile}"
cat > /dev/null
printf '200\\n{"content-type":["text/plain"]}' >&2
printf 'from ssh_pass'
`,
);
chmodSync(join(bin, "ssh"), 0o755);

const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  route http://ssh-pass.test/* {
    ssh_pass "-p" "2222" "user@remote.test" {
      command_pass curl "--max-time" "5"
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
const route = (body: string) => `proxy {\n  route / {\n${body}\n  }\n}\n`;
const sshPass = (inner: string, line = `"user@remote.test"`) => route(`    ssh_pass ${line} {\n${inner}\n    }`);

testFeature(manifestPayload, ["/proxy/route/ssh_pass"], "should run the request over ssh with the curl of the nested command_pass", async () => {
  const res = await fetch("http://ssh-pass.test/some/path?x=1", { proxy });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("from ssh_pass");
  // ssh options first, then the destination, then a single remote command that carries the curl options.
  const args = readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
  expect(args.slice(0, 2)).toEqual(["-p", "2222"]);
  expect(args.indexOf("user@remote.test")).toBe(args.length - 2);
  expect(args).toContain("BatchMode=yes");
  expect(args.at(-1)).toContain("curl -K");
  expect(args.at(-1)).toContain("'--max-time' '5'");
});

for (const engine of ["curl", "wget", "node"] as const) {
  testFeature(sshPass(`      command_pass ${engine}`), ["/proxy/route/ssh_pass/command_pass"], `should use the ${engine} engine of the nested command_pass in ssh_pass`, async (payload) => {
    const [first] = (await load(payload)).routes;
    expect(first!.action).toMatchObject({ kind: "command_pass", command: "ssh", engine, args: ["user@remote.test"], concurrency: 1 });
  });
}

testFeature(
  sshPass(`      command_pass curl {\n        concurrency 3\n        max_time 5\n        extra_args --foo tar\n      }`),
  ["/proxy/route/ssh_pass/command_pass"],
  "should read the concurrency and the options of the nested command_pass in ssh_pass",
  async (payload) => {
    const [first] = (await load(payload)).routes;
    expect(first!.action).toMatchObject({ concurrency: 3, engineArgs: ["--foo", "tar", "--max-time", "5"] });
  },
);

testFeature(route(`    ssh_pass {\n      command_pass curl\n    }`), ["/proxy/route/ssh_pass"], "should reject ssh_pass without a destination", async (payload) => {
  await expect(load(payload)).rejects.toThrow("ssh_pass requiere el destino");
});

testFeature(route(`    ssh_pass "user@remote.test"`), ["/proxy/route/ssh_pass"], "should reject ssh_pass without a nested command_pass", async (payload) => {
  await expect(load(payload)).rejects.toThrow("ssh_pass requiere un command_pass hijo");
});

testFeature(sshPass(`      command_pass ssh`), ["/proxy/route/ssh_pass"], "should reject a nested command_pass that is not curl, wget or node", async (payload) => {
  await expect(load(payload)).rejects.toThrow('ssh_pass requiere un command_pass hijo con "curl", "wget" o "node", no "ssh"');
});

testFeature(route(`    respond 200 "x"\n    ssh_pass "user@remote.test" {\n      command_pass curl\n    }`), ["/proxy/route"], "should reject a route that combines ssh_pass with another action", async (payload) => {
  await expect(load(payload)).rejects.toThrow("exactamente uno");
});
