import { afterAll, beforeAll, expect } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "../../server";
import { testFeature } from "../../../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-ssh-"));
const bin = join(dir, "bin");
const argsFile = join(dir, "ssh.args");
const evilFile = join(dir, "pwned");

// A fake `ssh`: records its arguments and runs the last one (the remote command) with
// `sh -c`, as the remote login shell would. stdin passes straight through.
mkdirSync(bin);
writeFileSync(
  join(bin, "ssh"),
  `#!/bin/sh\nprintf '%s\\0' "$@" > "${argsFile}"\nfor last; do :; done\nexec sh -c "$last"\n`,
);
chmodSync(join(bin, "ssh"), 0o755);

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

const manifestPayload = (port: number) =>
  manifest(`  route http://127.0.0.1:${port}/curl/ {
    command_pass ssh "-p" "2222" "user@remote.test" {
      engine curl
    }
  }
  route http://127.0.0.1:${port}/node/ {
    command_pass ssh "user@remote.test" {
      engine node
    }
  }
  route http://127.0.0.1:${port}/default/ {
    command_pass ssh "user@remote.test"
  }`);

// Representative payload of the tests below (they use the port of a real upstream).
const payload = manifestPayload(8080);

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  port = (upstream.address() as AddressInfo).port;
  writeFileSync(join(dir, "manifest.donly"), manifestPayload(port));
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

const sshArgs = () => readFileSync(argsFile, "utf8").split("\0").slice(0, -1);

for (const engine of ["curl", "node"] as const) {
  testFeature(payload, ["/proxy/route/command_pass/engine"], `command_pass ssh with engine ${engine} runs the request on the remote host`, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/${engine}/path?x=1`, {
      proxy,
      method: "POST",
      body: "payload",
      headers: { "x-custom": "abc" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upstream")).toBe("yes");
    expect(await res.json()).toEqual({ method: "POST", url: `/${engine}/path?x=1`, custom: "abc", body: "payload" });

    // ssh options first, then the destination, then a single remote command.
    const args = sshArgs();
    expect(args.indexOf("user@remote.test")).toBe(args.length - 2);
    expect(args).toContain("BatchMode=yes");
    if (engine === "curl") expect(args.slice(0, 2)).toEqual(["-p", "2222"]);
    expect(args.at(-1)).toContain(engine === "curl" ? "curl -K" : "node --input-type=module -");
  });
}

testFeature(payload, ["/proxy/route/command_pass"], "command_pass ssh uses curl when no engine is given", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/default/`, { proxy });
  expect((await res.json()).url).toBe("/default/");
  expect(sshArgs().at(-1)).toContain("curl -K");
});

testFeature(payload, ["/proxy/route/command_pass"], "request data never reaches the remote command line or a shell", async () => {
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
    const remoteCommand = sshArgs().at(-1)!;
    expect(remoteCommand).not.toContain(port.toString());
    expect(remoteCommand).not.toContain("touch");
  }
  expect(existsSync(evilFile)).toBe(false);
});

testFeature(payload, ["/proxy/route/command_pass"], "ssh failures are reported as a bad gateway", async () => {
  const failing = join(dir, "failing");
  mkdirSync(failing);
  writeFileSync(join(failing, "ssh"), "#!/bin/sh\necho 'connection refused' >&2\nexit 255\n");
  chmodSync(join(failing, "ssh"), 0o755);
  process.env.PATH = `${failing}${delimiter}${bin}${delimiter}${saved.PATH}`;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/curl/`, { proxy });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("ssh curl exited with 255: connection refused");
  } finally {
    process.env.PATH = `${bin}${delimiter}${saved.PATH}`;
  }
});

testFeature(manifest(`  route / {\n command_pass ssh\n }`), ["/proxy/route/command_pass"], "manifest validation for ssh and engine", async () => {
  const load = (route: string) => {
    const file = join(dir, `v-${Math.random()}.donly`);
    writeFileSync(file, manifest(route));
    return loadConfig(file);
  };
  expect(load(`route / {\n command_pass ssh\n }`)).rejects.toThrow("requiere el destino");
  expect(load(`route / {\n command_pass ssh host {\n engine perl\n }\n }`)).rejects.toThrow("engine solo soporta");
  expect(load(`route / {\n command_pass curl {\n engine node\n }\n }`)).rejects.toThrow("solo aplica a command_pass ssh y kubectl");
  expect(load(`route / {\n command_pass rsh host\n }`)).rejects.toThrow("solo soporta");
});
