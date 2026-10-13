import { afterAll, beforeAll, expect } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "../../server";
import { testFeature } from "../../../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-max-time-"));
const bin = join(dir, "bin");
const argsFile = join(dir, "curl.args");

// A fake `curl` that records its arguments and answers like curl does with the proxy's flags.
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
  route http://max-time.test/ {
    command_pass curl {
      max_time 5
    }
  }
  route http://combined.test/ {
    command_pass curl "--insecure" {
      max_time 2.5
    }
  }
  route http://plain.test/ {
    command_pass curl
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
const load = (payload: string) => {
  const file = join(dir, `v-${Math.random()}.donly`);
  writeFileSync(file, payload);
  return loadConfig(file);
};
const route = (body: string) => `proxy {\n  route / {\n${body}\n  }\n}\n`;

testFeature(manifestPayload, ["/proxy/route/command_pass/max_time"], "should pass --max-time 5 to curl when command_pass curl has max_time 5", async () => {
  const res = await fetch("http://max-time.test/", { proxy });
  expect(await res.text()).toBe("ok");
  const args = curlArgs();
  expect(args.slice(args.indexOf("--max-time"), args.indexOf("--max-time") + 2)).toEqual(["--max-time", "5"]);
});

testFeature(manifestPayload, ["/proxy/route/command_pass"], "should combine max_time with the options given as arguments", async () => {
  await (await fetch("http://combined.test/", { proxy })).text();
  const args = curlArgs();
  expect(args).toContain("--insecure");
  expect(args.slice(args.indexOf("--max-time"), args.indexOf("--max-time") + 2)).toEqual(["--max-time", "2.5"]);
});

testFeature(manifestPayload, ["/proxy/route/command_pass"], "should not pass --max-time to curl without max_time", async () => {
  await (await fetch("http://plain.test/", { proxy })).text();
  expect(curlArgs()).not.toContain("--max-time");
});

testFeature(route(`    command_pass curl {\n      max_time 0\n    }`), ["/proxy/route/command_pass/max_time"], "should reject a max_time that is not a positive number", async () => {
  for (const value of ["0", "-1", "soon", '"5"']) {
    await expect(load(route(`    command_pass curl {\n      max_time ${value}\n    }`))).rejects.toThrow("max_time debe ser un número positivo");
  }
});

testFeature(route(`    command_pass node {\n      max_time 5\n    }`), ["/proxy/route/command_pass/max_time"], "should reject max_time outside command_pass curl", async (payload) => {
  await expect(load(payload)).rejects.toThrow("max_time solo aplica a command_pass curl");
});

testFeature(
  route(`    kubectl_pass "pod/api" {\n      command_pass curl {\n        max_time 5\n      }\n    }`),
  ["/proxy/route/kubectl_pass/command_pass/max_time"],
  "should pass --max-time to the curl run by kubectl_pass",
  async (payload) => {
    const [first] = (await load(payload)).routes;
    expect(first!.action).toMatchObject({ kind: "command_pass", command: "kubectl", engine: "curl", engineArgs: ["--max-time", "5"] });
  },
);
