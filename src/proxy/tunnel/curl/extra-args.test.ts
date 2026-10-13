import { afterAll, beforeAll, expect } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "../../server";
import { testFeature } from "../../../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-extra-args-"));
const bin = join(dir, "bin");
const argsFile = join(dir, "curl.args");
const evilFile = join(dir, "pwned");

// A fake `curl` that records its arguments (one per line) and answers like curl does.
mkdirSync(bin);
writeFileSync(
  join(bin, "curl"),
  `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
cat > /dev/null
printf '200\\n{"content-type":["text/plain"]}' >&2
printf 'ok'
`,
);
chmodSync(join(bin, "curl"), 0o755);

const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  route http://extra.test/ {
    command_pass curl {
      extra_args --foo tar --biz lol
    }
  }
  route http://ordered.test/ {
    command_pass curl "--insecure" {
      extra_args --retry 3
      max_time 5
    }
  }
  route http://quoted.test/ {
    command_pass curl {
      extra_args "--header" "x-evil: a b; touch ${evilFile}" "$(touch ${evilFile})"
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

const curlArgs = () => readFileSync(argsFile, "utf8").split("\n");
const slice = (args: string[], from: string, length: number) => args.slice(args.indexOf(from), args.indexOf(from) + length);
const load = (payload: string) => {
  const file = join(dir, `v-${Math.random()}.donly`);
  writeFileSync(file, payload);
  return loadConfig(file);
};
const route = (body: string) => `proxy {\n  route / {\n${body}\n  }\n}\n`;

testFeature(manifestPayload, ["/proxy/route/command_pass/extra_args"], "should pass the extra_args values to curl as separate arguments", async () => {
  expect(await (await fetch("http://extra.test/", { proxy })).text()).toBe("ok");
  expect(slice(curlArgs(), "--foo", 4)).toEqual(["--foo", "tar", "--biz", "lol"]);
});

testFeature(manifestPayload, ["/proxy/route/command_pass"], "should put the extra_args after the arguments of the line and before max_time", async () => {
  await (await fetch("http://ordered.test/", { proxy })).text();
  const args = curlArgs();
  expect(args.indexOf("--insecure")).toBeLessThan(args.indexOf("--retry"));
  expect(slice(args, "--retry", 2)).toEqual(["--retry", "3"]); // numbers become strings
  expect(args.indexOf("--retry")).toBeLessThan(args.indexOf("--max-time"));
  expect(slice(args, "--max-time", 2)).toEqual(["--max-time", "5"]);
});

testFeature(manifestPayload, ["/proxy/route/command_pass/extra_args"], "should not let the extra_args values reach a shell", async () => {
  await (await fetch("http://quoted.test/", { proxy })).text();
  const args = curlArgs();
  expect(args).toContain(`x-evil: a b; touch ${evilFile}`);
  expect(args).toContain(`$(touch ${evilFile})`);
  expect(existsSync(evilFile)).toBe(false);
});

testFeature(
  route(`    command_pass ssh "user@remote.test" {\n      extra_args "-p" 2222\n    }`),
  ["/proxy/route/command_pass/extra_args"],
  "should add the extra_args to the arguments of command_pass ssh",
  async (payload) => {
    const [first] = (await load(payload)).routes;
    expect(first!.action).toMatchObject({ kind: "command_pass", command: "ssh", args: ["user@remote.test", "-p", "2222"] });
  },
);

testFeature(
  route(`    kubectl_pass "pod/api" {\n      command_pass curl {\n        extra_args --foo tar\n      }\n    }`),
  ["/proxy/route/kubectl_pass/command_pass/extra_args"],
  "should pass the extra_args to the curl run by kubectl_pass",
  async (payload) => {
    const [first] = (await load(payload)).routes;
    expect(first!.action).toMatchObject({ kind: "command_pass", command: "kubectl", engine: "curl", engineArgs: ["--foo", "tar"] });
  },
);
