import { afterAll, beforeAll, expect } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "../../server";
import { testFeature } from "../../../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-ssh-pass-auth-"));
const bin = join(dir, "bin");
const argsFile = join(dir, "ssh.args");
const envFile = join(dir, "ssh.env");
const logFile = join(dir, "proxy.ndjson");

// A fake `ssh` that records its arguments (NUL separated) and the variables of the askpass
// protocol, and answers like the curl engine does.
mkdirSync(bin);
writeFileSync(
  join(bin, "ssh"),
  `#!/bin/sh
printf '%s\\0' "$@" > "${argsFile}"
printf '%s\\n%s\\n%s\\n' "$SSH_ASKPASS" "$SSH_ASKPASS_REQUIRE" "$DONLY_SSH_PASSWORD" > "${envFile}"
cat > /dev/null
printf '200\\n{"content-type":["text/plain"]}' >&2
printf 'ok'
`,
);
chmodSync(join(bin, "ssh"), 0o755);

const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  log_file "./proxy.ndjson"
  route http://alias.test/* {
    ssh_pass myserver {
      idle_time 0
      command_pass curl
    }
  }
  route http://port.test/* {
    ssh_pass myserver {
      idle_time 0
      port 2222
      command_pass curl
    }
  }
  route http://user.test/* {
    ssh_pass myserver {
      idle_time 0
      user jon
      port 2200
      command_pass curl
    }
  }
  route http://options.test/* {
    ssh_pass myserver "-v" {
      idle_time 0
      command_pass curl
    }
  }
  route http://password.test/* {
    ssh_pass myserver {
      idle_time 0
      user jon
      pass "s3cr3t pa$$"
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

/** The ssh arguments without the fixed ones and the remote command: options, then the host. */
const sshArgs = () => {
  const args = readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
  return args.slice(0, -1);
};
const load = (payload: string) => {
  const file = join(dir, `v-${Math.random()}.donly`);
  writeFileSync(file, payload);
  return loadConfig(file);
};
const route = (body: string) => `proxy {\n  route / {\n${body}\n  }\n}\n`;
const sshPass = (children: string, line = "myserver") => route(`    ssh_pass ${line} {\n${children}\n      command_pass curl\n    }`);

testFeature(manifestPayload, ["/proxy/route/ssh_pass"], "should use the first argument of ssh_pass as the host, so ~/.ssh/config applies", async () => {
  expect(await (await fetch("http://alias.test/", { proxy })).text()).toBe("ok");
  const args = sshArgs();
  expect(args.at(-1)).toBe("myserver");
  expect(args).not.toContain("-p");
  expect(args).not.toContain("-l");
});

testFeature(manifestPayload, ["/proxy/route/ssh_pass/port"], "should pass the port subdirective of ssh_pass as -p", async () => {
  await (await fetch("http://port.test/", { proxy })).text();
  const args = sshArgs();
  expect(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2)).toEqual(["-p", "2222"]);
  expect(args.at(-1)).toBe("myserver");
});

testFeature(manifestPayload, ["/proxy/route/ssh_pass/user", "/proxy/route/ssh_pass/port"], "should pass the user subdirective of ssh_pass as -l", async () => {
  await (await fetch("http://user.test/", { proxy })).text();
  const args = sshArgs();
  expect(args.slice(args.indexOf("-l"), args.indexOf("-l") + 2)).toEqual(["-l", "jon"]);
  expect(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2)).toEqual(["-p", "2200"]);
  expect(args.at(-1)).toBe("myserver");
});

testFeature(manifestPayload, ["/proxy/route/ssh_pass"], "should put the arguments after the host of ssh_pass before the host as ssh options", async () => {
  await (await fetch("http://options.test/", { proxy })).text();
  const args = sshArgs();
  expect(args.indexOf("-v")).toBeLessThan(args.indexOf("myserver"));
  expect(args.at(-1)).toBe("myserver");
});

testFeature(manifestPayload, ["/proxy/route/ssh_pass"], "should keep BatchMode and no askpass in ssh_pass without pass", async () => {
  await (await fetch("http://alias.test/", { proxy })).text();
  expect(sshArgs()).toContain("BatchMode=yes");
  expect(readFileSync(envFile, "utf8").split("\n").slice(0, 3)).toEqual(["", "", ""]);
});

testFeature(manifestPayload, ["/proxy/route/ssh_pass/pass"], "should hand the pass of ssh_pass to ssh through an askpass program, never on the command line", async () => {
  const password = "s3cr3t pa$$";
  const before = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).length : 0;
  await (await fetch("http://password.test/", { proxy })).text();
  const args = readFileSync(argsFile, "utf8").split("\0");
  expect(args.join(" ")).not.toContain(password);
  expect(args).not.toContain("BatchMode=yes");
  const [askpass, require, received] = readFileSync(envFile, "utf8").split("\n");
  expect(require).toBe("force");
  expect(received).toBe(password);
  // The askpass program prints the password, and only the owner can use it.
  expect(statSync(askpass!).mode & 0o077).toBe(0);
  const printed = Bun.spawnSync([askpass!], { env: { DONLY_SSH_PASSWORD: password } });
  expect(printed.stdout.toString()).toBe(`${password}\n`);
  // The log keeps the command that was executed, without the password.
  const logged = readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(before).join("\n");
  expect(logged).toContain("myserver");
  expect(logged).not.toContain(password);
});

testFeature(sshPass(`      port 0`), ["/proxy/route/ssh_pass/port"], "should reject a port that is not between 1 and 65535", async () => {
  for (const value of ["0", "65536", "1.5", "web", '"22"']) {
    await expect(load(sshPass(`      port ${value}`))).rejects.toThrow("port debe ser un puerto entre 1 y 65535");
  }
});

testFeature(sshPass(`      user ""`), ["/proxy/route/ssh_pass/user"], "should reject a user that is not a name", async () => {
  for (const value of ['""', "5", "true"]) {
    await expect(load(sshPass(`      user ${value}`))).rejects.toThrow("user debe ser un nombre");
  }
});

testFeature(sshPass(`      pass ""`), ["/proxy/route/ssh_pass/pass"], "should reject a pass that is empty or not a text", async () => {
  for (const value of ['""', "true"]) {
    await expect(load(sshPass(`      pass ${value}`))).rejects.toThrow("pass debe ser un texto no vacío");
  }
});

testFeature(sshPass(`      port 2222`, `"-p" "22" "user@remote.test"`), ["/proxy/route/ssh_pass"], "should keep the options-then-destination form of ssh_pass", async (payload) => {
  const [first] = (await load(payload)).routes;
  expect(first!.action).toMatchObject({ command: "ssh", args: ["-p", "22", "-p", "2222", "user@remote.test"] });
});
