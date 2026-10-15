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
  route http://alias.test/ {
    kubectl_pass "pod/api-0" {
      namespaces the-namespace
      command_pass curl
    }
  }
  route http://podname.test/ {
    kubectl_pass "pod/api-0" {
      namespace the-namespace
      command_pass curl
    }
  }
  route http://ctxns.test/ {
    kubectl_pass "pod/api-0" {
      context the-context
      namespace the-namespace
      command_pass curl
    }
  }
  route http://plain.test/ {
    kubectl_pass "deploy/api" {
      command_pass curl
    }
  }
  route http://cp-both.test/ {
    command_pass kubectl "deploy/api" {
      context dev
      namespace prod
    }
  }
  route http://cp-options.test/ {
    command_pass kubectl "--kubeconfig" "/tmp/kube" "deploy/api" {
      namespace staging
      engine curl
    }
  }
  route http://cp-extra.test/ {
    command_pass kubectl "deploy/api" {
      extra_args --request-timeout 5s
      namespace prod
    }
  }
  route http://cp-plain.test/ {
    command_pass kubectl "-n" "prod" "deploy/api"
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

testFeature(manifestPayload, ["/proxy/route/kubectl_pass/namespace"], "should accept namespaces as an alias of namespace", async () => {
  await (await fetch("http://alias.test/", { proxy })).text();
  expect(kubectlOptions()).toEqual(["--namespace", "the-namespace", "pod/api-0"]);
});

testFeature(manifestPayload, ["/proxy/route/kubectl_pass/namespace"], "should send the namespace to kubectl exec when namespace is defined", async () => {
  await (await fetch("http://podname.test/", { proxy })).text();
  const args = readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
  expect(args.slice(0, 3)).toEqual(["exec", "-i", "-q"]);
  expect(args.slice(3, args.indexOf("--"))).toEqual(["--namespace", "the-namespace", "pod/api-0"]);
});

testFeature(manifestPayload, ["/proxy/route/kubectl_pass/context", "/proxy/route/kubectl_pass/namespace"], "should call kubectl exec with --context and --namespace when both are defined", async () => {
  await (await fetch("http://ctxns.test/", { proxy })).text();
  const args = readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
  expect(args.slice(0, 3)).toEqual(["exec", "-i", "-q"]);
  expect(args.slice(3, args.indexOf("--"))).toEqual(["--context", "the-context", "--namespace", "the-namespace", "pod/api-0"]);
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

// The same subdirectives in `command_pass kubectl`.
testFeature(manifestPayload, ["/proxy/route/command_pass/context", "/proxy/route/command_pass/namespace"], "should pass --context and --namespace to kubectl in command_pass kubectl", async () => {
  expect(await (await fetch("http://cp-both.test/", { proxy })).text()).toBe("ok");
  expect(kubectlOptions()).toEqual(["--context", "dev", "--namespace", "prod", "deploy/api"]);
});

testFeature(manifestPayload, ["/proxy/route/command_pass/namespace"], "should put the selectors of command_pass kubectl after the options given as arguments", async () => {
  await (await fetch("http://cp-options.test/", { proxy })).text();
  expect(kubectlOptions()).toEqual(["--kubeconfig", "/tmp/kube", "--namespace", "staging", "deploy/api"]);
});

testFeature(manifestPayload, ["/proxy/route/command_pass"], "should keep the options of command_pass kubectl without selectors", async () => {
  await (await fetch("http://cp-plain.test/", { proxy })).text();
  expect(kubectlOptions()).toEqual(["-n", "prod", "deploy/api"]);
});

testFeature(route(`    command_pass kubectl "pod/x" {\n      namespace 5\n    }`), ["/proxy/route/command_pass/namespace"], "should reject a namespace of command_pass kubectl that is not a name", async (payload) => {
  await expect(load(payload)).rejects.toThrow("namespace debe ser un nombre");
});

testFeature(route(`    command_pass kubectl "pod/x" {\n      context ""\n    }`), ["/proxy/route/command_pass/context"], "should reject a context of command_pass kubectl that is not a name", async (payload) => {
  await expect(load(payload)).rejects.toThrow("context debe ser un nombre");
});

testFeature(route(`    command_pass ssh "user@remote.test" {\n      namespace prod\n    }`), ["/proxy/route/command_pass/namespace"], "should reject context and namespace outside kubectl", async (payload) => {
  await expect(load(payload)).rejects.toThrow("namespace solo aplica a kubectl_pass y command_pass kubectl");
});

testFeature(manifestPayload, ["/proxy/route/command_pass/extra_args", "/proxy/route/command_pass/namespace"], "should keep the target of command_pass kubectl last with extra_args and selectors", async () => {
  await (await fetch("http://cp-extra.test/", { proxy })).text();
  expect(kubectlOptions()).toEqual(["--request-timeout", "5s", "--namespace", "prod", "deploy/api"]);
});
