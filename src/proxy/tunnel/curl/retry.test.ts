import { afterAll, beforeAll, expect } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "../../server";
import { testFeature } from "../../../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-retry-"));
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
  route http://retry.test/ {
    command_pass curl {
      retry 5
    }
  }
  route http://zero.test/ {
    command_pass curl {
      retry 0
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
const slice = (args: string[], from: string, length: number) => args.slice(args.indexOf(from), args.indexOf(from) + length);
const load = (payload: string) => {
  const file = join(dir, `v-${Math.random()}.donly`);
  writeFileSync(file, payload);
  return loadConfig(file);
};
const route = (body: string) => `proxy {\n  route / {\n${body}\n  }\n}\n`;

testFeature(manifestPayload, ["/proxy/route/command_pass/retry"], "should pass --retry 5 to curl when command_pass curl has retry 5", async () => {
  expect(await (await fetch("http://retry.test/", { proxy })).text()).toBe("ok");
  expect(slice(curlArgs(), "--retry", 2)).toEqual(["--retry", "5"]);
});

testFeature(manifestPayload, ["/proxy/route/command_pass/retry"], "should pass --retry 0 to curl with retry 0", async () => {
  await (await fetch("http://zero.test/", { proxy })).text();
  expect(slice(curlArgs(), "--retry", 2)).toEqual(["--retry", "0"]);
});

testFeature(manifestPayload, ["/proxy/route/command_pass"], "should not pass --retry to curl without retry", async () => {
  await (await fetch("http://plain.test/", { proxy })).text();
  expect(curlArgs()).not.toContain("--retry");
});

testFeature(route(`    command_pass curl {\n      retry -1\n    }`), ["/proxy/route/command_pass/retry"], "should reject a retry that is not a non-negative integer", async () => {
  for (const value of ["-1", "1.5", "many", '"5"']) {
    await expect(load(route(`    command_pass curl {\n      retry ${value}\n    }`))).rejects.toThrow("retry debe ser un entero no negativo");
  }
});

testFeature(route(`    command_pass node {\n      retry 5\n    }`), ["/proxy/route/command_pass/retry"], "should reject retry outside command_pass curl", async (payload) => {
  await expect(load(payload)).rejects.toThrow("retry solo aplica a command_pass curl");
});

testFeature(
  route(`    kubectl_pass "pod/api" {\n      command_pass curl {\n        retry 5\n      }\n    }`),
  ["/proxy/route/kubectl_pass/command_pass/retry"],
  "should pass --retry to the curl run by kubectl_pass",
  async (payload) => {
    const [first] = (await load(payload)).routes;
    expect(first!.action).toMatchObject({ kind: "command_pass", command: "kubectl", engine: "curl", engineArgs: ["--retry", "5"] });
  },
);
