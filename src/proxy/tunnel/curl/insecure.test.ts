import { afterAll, beforeAll, expect } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "../../server";
import { testFeature } from "../../../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-insecure-"));
const bin = join(dir, "bin");
const argsFile = join(dir, "curl.args");

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
  route http://insecure.test/ {
    command_pass curl {
      insecure
    }
  }
  route http://explicit.test/ {
    command_pass curl {
      insecure true
    }
  }
  route http://disabled.test/ {
    command_pass curl {
      insecure false
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

testFeature(manifestPayload, ["/proxy/route/command_pass/insecure"], "should pass --insecure to curl when command_pass curl has insecure", async () => {
  expect(await (await fetch("http://insecure.test/", { proxy })).text()).toBe("ok");
  expect(curlArgs()).toContain("--insecure");
});

testFeature(manifestPayload, ["/proxy/route/command_pass/insecure"], "should pass --insecure to curl with insecure true", async () => {
  await (await fetch("http://explicit.test/", { proxy })).text();
  expect(curlArgs()).toContain("--insecure");
});

testFeature(manifestPayload, ["/proxy/route/command_pass/insecure"], "should not pass --insecure to curl with insecure false", async () => {
  await (await fetch("http://disabled.test/", { proxy })).text();
  expect(curlArgs()).not.toContain("--insecure");
});

testFeature(manifestPayload, ["/proxy/route/command_pass"], "should not pass --insecure to curl without insecure", async () => {
  await (await fetch("http://plain.test/", { proxy })).text();
  expect(curlArgs()).not.toContain("--insecure");
});

testFeature(route(`    command_pass curl {\n      insecure maybe\n    }`), ["/proxy/route/command_pass/insecure"], "should reject an insecure that is not true or false", async (payload) => {
  await expect(load(payload)).rejects.toThrow("insecure debe ser true o false");
});

testFeature(route(`    command_pass node {\n      insecure\n    }`), ["/proxy/route/command_pass/insecure"], "should reject insecure outside command_pass curl", async (payload) => {
  await expect(load(payload)).rejects.toThrow("insecure solo aplica a command_pass curl");
});

testFeature(
  route(`    kubectl_pass "pod/api" {\n      command_pass curl {\n        insecure\n      }\n    }`),
  ["/proxy/route/kubectl_pass/command_pass/insecure"],
  "should pass --insecure to the curl run by kubectl_pass",
  async (payload) => {
    const [first] = (await load(payload)).routes;
    expect(first!.action).toMatchObject({ kind: "command_pass", command: "kubectl", engine: "curl", engineArgs: ["--insecure"] });
  },
);
