import { afterAll, beforeAll, expect } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

// Pins that the short forms (`ssh_pass`, `kubectl_pass`) launch exactly what `command_pass ssh|kubectl` does,
// and the order of the arguments, observed through fake binaries.
const dir = mkdtempSync(join(tmpdir(), "donly-proxy-equivalence-"));
const bin = join(dir, "bin");
const sshFile = join(dir, "ssh.args");
const kubectlFile = join(dir, "kubectl.args");

mkdirSync(bin);
writeFileSync(join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\0' "$@" > "${sshFile}"\nfor last; do :; done\nexec sh -c "$last"\n`);
writeFileSync(
  join(bin, "kubectl"),
  `#!/bin/sh\nprintf '%s\\0' "$@" > "${kubectlFile}"\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
);
chmodSync(join(bin, "ssh"), 0o755);
chmodSync(join(bin, "kubectl"), 0o755);

const upstream = http.createServer((req, res) => {
  res.end(JSON.stringify({ url: req.url }));
});

const saved = { PATH: process.env.PATH, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
let server: ReturnType<typeof createProxyServer>;
let proxy: string;
let port: number;

const routes = (port: number) => `  route http://127.0.0.1:${port}/ssh-long/* {
    command_pass ssh "-p" "2222" "user@remote.test" {
      engine curl
    }
  }
  route http://127.0.0.1:${port}/ssh-short/* {
    ssh_pass "-p" "2222" "user@remote.test" {
      command_pass curl
    }
  }
  route http://127.0.0.1:${port}/ssh-opts-long/* {
    command_pass ssh "user@remote.test" {
      engine node
      extra_args "-o" "ConnectTimeout=3"
    }
  }
  route http://127.0.0.1:${port}/ssh-opts-short/* {
    ssh_pass "user@remote.test" {
      extra_args "-o" "ConnectTimeout=3"
      command_pass node
    }
  }
  route http://127.0.0.1:${port}/kube-long/* {
    command_pass kubectl "-n" "prod" "--context" "dev" "deploy/api" {
      engine curl
    }
  }
  route http://127.0.0.1:${port}/kube-short/* {
    kubectl_pass "-n" "prod" "--context" "dev" "deploy/api" {
      command_pass curl
    }
  }
  route http://127.0.0.1:${port}/kube-sel-long/* {
    command_pass kubectl "pod/api-0" {
      engine node
      context dev
      namespace prod
    }
  }
  route http://127.0.0.1:${port}/kube-sel-short/* {
    kubectl_pass "pod/api-0" {
      context dev
      namespace prod
      command_pass node
    }
  }
  route http://127.0.0.1:${port}/kube-ns-alias/* {
    kubectl_pass "pod/api-0" {
      context dev
      namespaces prod
      command_pass node
    }
  }`;

const manifest = (port: number) => `proxy {\n  host "127.0.0.1"\n  port 0\n${routes(port)}\n}\n`;
const payload = manifest(8080);

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  port = (upstream.address() as AddressInfo).port;
  writeFileSync(join(dir, "manifest.donly"), manifest(port));
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
  upstream.close();
});

const read = (file: string) => readFileSync(file, "utf8").split("\0").slice(0, -1);
const call = async (route: string) => {
  const res = await fetch(`http://127.0.0.1:${port}/${route}/x`, { proxy });
  expect(res.status).toBe(200);
};
const sshHead = () => read(sshFile).slice(0, -1);
const kubectlHead = () => read(kubectlFile).slice(0, read(kubectlFile).indexOf("--") + 1);

testFeature(payload, ["/proxy/route/ssh_pass", "/proxy/route/command_pass"], "should launch ssh_pass with the same ssh arguments as command_pass ssh", async () => {
  await call("ssh-long");
  const long = sshHead();
  await call("ssh-short");
  expect(sshHead()).toEqual(long);
  expect(long.slice(0, 2)).toEqual(["-p", "2222"]);
  expect(long.at(-1)).toBe("user@remote.test");
});

testFeature(payload, ["/proxy/route/ssh_pass", "/proxy/route/command_pass"], "should run the same engine remotely in ssh_pass and command_pass ssh", async () => {
  await call("ssh-long");
  const long = read(sshFile).at(-1)!;
  await call("ssh-short");
  expect(read(sshFile).at(-1)!).toContain("curl -K");
  expect(long).toContain("curl -K");
});

testFeature(payload, ["/proxy/route/ssh_pass", "/proxy/route/command_pass/extra_args"], "should put extra_args before the destination in both ssh forms", async () => {
  await call("ssh-opts-long");
  const long = sshHead();
  await call("ssh-opts-short");
  expect(sshHead()).toEqual(long);
  expect(long.slice(long.indexOf("ConnectTimeout=3") - 1, long.indexOf("ConnectTimeout=3") + 1)).toEqual(["-o", "ConnectTimeout=3"]);
  expect(long.indexOf("ConnectTimeout=3")).toBeLessThan(long.indexOf("user@remote.test"));
  expect(long.at(-1)).toBe("user@remote.test");
});

testFeature(payload, ["/proxy/route/kubectl_pass", "/proxy/route/command_pass"], "should launch kubectl_pass with the same kubectl arguments as command_pass kubectl", async () => {
  await call("kube-long");
  const long = kubectlHead();
  await call("kube-short");
  expect(kubectlHead()).toEqual(long);
  expect(long).toEqual(expect.arrayContaining(["-n", "prod", "--context", "dev", "deploy/api", "--"]));
});

testFeature(payload, ["/proxy/route/kubectl_pass", "/proxy/route/command_pass/context"], "should put context and namespace before the target in both kubectl forms", async () => {
  await call("kube-sel-long");
  const long = kubectlHead();
  await call("kube-sel-short");
  expect(kubectlHead()).toEqual(long);
  expect(long.indexOf("--context")).toBeLessThan(long.indexOf("pod/api-0"));
  expect(long.indexOf("--namespace")).toBeLessThan(long.indexOf("pod/api-0"));
  expect(long.slice(long.indexOf("--context"), long.indexOf("--context") + 2)).toEqual(["--context", "dev"]);
  expect(long.slice(long.indexOf("--namespace"), long.indexOf("--namespace") + 2)).toEqual(["--namespace", "prod"]);
});

testFeature(payload, ["/proxy/route/kubectl_pass/namespace"], "should treat namespaces as an alias of namespace", async () => {
  await call("kube-sel-short");
  const namespace = kubectlHead();
  await call("kube-ns-alias");
  expect(kubectlHead()).toEqual(namespace);
});
