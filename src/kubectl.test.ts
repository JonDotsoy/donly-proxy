import { afterAll, beforeAll, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "./server";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-kubectl-"));
const bin = join(dir, "bin");
const argsFile = join(dir, "kubectl.args");
const evilFile = join(dir, "pwned");

// A fake `kubectl`: records its arguments and runs what follows `--` locally, as
// `kubectl exec` would run it inside the container. stdin passes straight through.
mkdirSync(bin);
writeFileSync(
  join(bin, "kubectl"),
  `#!/bin/sh
printf '%s\\0' "$@" > "${argsFile}"
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
);
chmodSync(join(bin, "kubectl"), 0o755);

const upstream = http.createServer(async (req, res) => {
  const body = Buffer.concat(await Array.fromAsync(req)).toString();
  res.setHeader("x-upstream", "yes");
  res.end(JSON.stringify({ method: req.method, url: req.url, custom: req.headers["x-custom"], body }));
});

const saved = { PATH: process.env.PATH, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
let server: http.Server;
let proxy: string;
let port: number;

const manifest = (route: string) => `proxy {\n  host "127.0.0.1"\n  port 0\n${route}\n}\n`;

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  port = (upstream.address() as AddressInfo).port;
  writeFileSync(
    join(dir, "manifest.donly"),
    manifest(`  route http://127.0.0.1:${port}/curl/ {
    command_pass kubectl "-n" "prod" "--context" "dev" "deploy/api" {
      engine curl
    }
  }
  route http://127.0.0.1:${port}/node/ {
    command_pass kubectl "pod/api-0" {
      engine node
    }
  }
  route http://127.0.0.1:${port}/default/ {
    command_pass kubectl "pod/api-0"
  }`),
  );
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

const kubectlArgs = () => readFileSync(argsFile, "utf8").split("\0").slice(0, -1);

for (const engine of ["curl", "node"] as const) {
  test(`[command_pass.kubectl.${engine}] command_pass kubectl with engine ${engine} runs the request inside the pod`, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/${engine}/path?x=1`, {
      proxy,
      method: "POST",
      body: "payload",
      headers: { "x-custom": "abc" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upstream")).toBe("yes");
    expect(await res.json()).toEqual({ method: "POST", url: `/${engine}/path?x=1`, custom: "abc", body: "payload" });

    // kubectl exec -i -q [options] <target> -- <command…>
    const args = kubectlArgs();
    expect(args.slice(0, 3)).toEqual(["exec", "-i", "-q"]);
    const separator = args.indexOf("--");
    expect(args[separator - 1]).toBe(engine === "curl" ? "deploy/api" : "pod/api-0");
    if (engine === "curl") {
      expect(args.slice(3, separator - 1)).toEqual(["-n", "prod", "--context", "dev"]);
      expect(args.slice(separator + 1, separator + 3)).toEqual(["sh", "-c"]);
      expect(args.at(-1)).toContain("curl -K");
    } else {
      expect(args.slice(separator + 1)).toEqual(["node", "--input-type=module", "-"]);
    }
  });
}

test("[command_pass.kubectl.default-engine] command_pass kubectl uses curl when no engine is given", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/default/`, { proxy });
  expect((await res.json()).url).toBe("/default/");
  expect(kubectlArgs().at(-1)).toContain("curl -K");
});

test("[command_pass.kubectl.no-shell-injection] request data never reaches the command line or a shell", async () => {
  const evil = `'; touch ${evilFile}; echo '`;
  for (const route of ["curl", "node"]) {
    const res = await fetch(`http://127.0.0.1:${port}/${route}/${encodeURIComponent(evil)}$(touch%20${evilFile})`, {
      proxy,
      method: "POST",
      body: evil,
      headers: { "x-custom": evil },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).custom).toBe(evil);
    const commandLine = kubectlArgs().join(" ");
    expect(commandLine).not.toContain(port.toString());
    expect(commandLine).not.toContain("touch");
  }
  expect(existsSync(evilFile)).toBe(false);
});

test("[command_pass.kubectl.error] kubectl failures are reported as a bad gateway", async () => {
  const failing = join(dir, "failing");
  mkdirSync(failing);
  writeFileSync(join(failing, "kubectl"), '#!/bin/sh\necho \'Error from server (NotFound): pods "api-0" not found\' >&2\nexit 1\n');
  chmodSync(join(failing, "kubectl"), 0o755);
  process.env.PATH = `${failing}${delimiter}${bin}${delimiter}${saved.PATH}`;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/curl/`, { proxy });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('kubectl curl exited with 1: Error from server (NotFound): pods "api-0" not found');
  } finally {
    process.env.PATH = `${bin}${delimiter}${saved.PATH}`;
  }
});

test("[command_pass.kubectl.validation] manifest validation for kubectl", async () => {
  const load = (route: string) => {
    const file = join(dir, `v-${Math.random()}.donly`);
    writeFileSync(file, manifest(route));
    return loadConfig(file);
  };
  expect(load(`route / {\n command_pass kubectl\n }`)).rejects.toThrow("pod o tipo/nombre");
  expect(load(`route / {\n command_pass kubectl pod/x {\n engine wget\n }\n }`)).rejects.toThrow("engine solo soporta");
});
