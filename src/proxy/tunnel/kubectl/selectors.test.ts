import { afterAll, beforeAll, expect } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "../../server";
import { testFeature } from "../../../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-kubectl-selectors-"));
const bin = join(dir, "bin");
const argsFile = join(dir, "kubectl.args");

// A fake `kubectl` that records its arguments (NUL separated) and answers like curl does.
mkdirSync(bin);
writeFileSync(
  join(bin, "kubectl"),
  `#!/bin/sh
printf '%s\\0' "$@" > "${argsFile}"
cat > /dev/null
printf '200\\n{"content-type":["text/plain"]}' >&2
printf 'ok'
`,
);
chmodSync(join(bin, "kubectl"), 0o755);

const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  route http://both.test/ {
    kubectl_pass "deploy/api" {
      context dev
      namespace prod
      command_pass curl
    }
  }
  route http://namespace.test/ {
    kubectl_pass "pod/api-0" {
      namespace staging
      command_pass curl
    }
  }
  route http://options.test/ {
    kubectl_pass "--kubeconfig" "/tmp/kube" "deploy/api" {
      context dev
      command_pass curl
    }
  }
  route http://plain.test/ {
    kubectl_pass "deploy/api" {
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

/** The kubectl options: what comes between `exec -i -q` and the `--` separator (target included). */
const kubectlOptions = () => {
  const args = readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
  return args.slice(3, args.indexOf("--"));
};
const load = (payload: string) => {
  const file = join(dir, `v-${Math.random()}.donly`);
  writeFileSync(file, payload);
  return loadConfig(file);
};
const route = (body: string) => `proxy {\n  route / {\n${body}\n  }\n}\n`;

testFeature(manifestPayload, ["/proxy/route/kubectl_pass/context", "/proxy/route/kubectl_pass/namespace"], "should pass --context and --namespace to kubectl before the target", async () => {
  expect(await (await fetch("http://both.test/", { proxy })).text()).toBe("ok");
  expect(kubectlOptions()).toEqual(["--context", "dev", "--namespace", "prod", "deploy/api"]);
});

testFeature(manifestPayload, ["/proxy/route/kubectl_pass/namespace"], "should pass only --namespace when kubectl_pass has no context", async () => {
  await (await fetch("http://namespace.test/", { proxy })).text();
  expect(kubectlOptions()).toEqual(["--namespace", "staging", "pod/api-0"]);
});

testFeature(manifestPayload, ["/proxy/route/kubectl_pass"], "should put the selectors after the options given as arguments", async () => {
  await (await fetch("http://options.test/", { proxy })).text();
  expect(kubectlOptions()).toEqual(["--kubeconfig", "/tmp/kube", "--context", "dev", "deploy/api"]);
});

testFeature(manifestPayload, ["/proxy/route/kubectl_pass"], "should not pass --context or --namespace without the selectors", async () => {
  await (await fetch("http://plain.test/", { proxy })).text();
  expect(kubectlOptions()).toEqual(["deploy/api"]);
});

testFeature(route(`    kubectl_pass "pod/x" {\n      namespace 5\n      command_pass curl\n    }`), ["/proxy/route/kubectl_pass/namespace"], "should reject a namespace that is not a name", async () => {
  for (const value of ["5", "true", '""']) {
    await expect(load(route(`    kubectl_pass "pod/x" {\n      namespace ${value}\n      command_pass curl\n    }`))).rejects.toThrow("namespace debe ser un nombre");
  }
});

testFeature(route(`    kubectl_pass "pod/x" {\n      context 5\n      command_pass curl\n    }`), ["/proxy/route/kubectl_pass/context"], "should reject a context that is not a name", async () => {
  for (const value of ["5", "true", '""']) {
    await expect(load(route(`    kubectl_pass "pod/x" {\n      context ${value}\n      command_pass curl\n    }`))).rejects.toThrow("context debe ser un nombre");
  }
});
