import { afterAll, beforeAll, expect } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "../../server";
import { testFeature } from "../../../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-no-warnings-"));
const bin = join(dir, "bin");
const argsFile = join(dir, "node.args");
const realNode = Bun.which("node");
if (!realNode) throw new Error("node is required for these tests");

// A `node` wrapper that records its arguments (one per line) and then runs the real node.
mkdirSync(bin);
writeFileSync(join(bin, "node"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nexec "${realNode}" "$@"\n`);
chmodSync(join(bin, "node"), 0o755);

const upstream = http.createServer((_req, res) => res.end("from upstream"));

const manifestPayload = (port: number) => `proxy {
  host "127.0.0.1"
  port 0
  route http://127.0.0.1:${port}/flag {
    command_pass node {
      no_warnings
    }
  }
  route http://127.0.0.1:${port}/true {
    command_pass node {
      no_warnings true
    }
  }
  route http://127.0.0.1:${port}/false {
    command_pass node {
      no_warnings false
    }
  }
  route http://127.0.0.1:${port}/ordered {
    command_pass node "--max-old-space-size=64" {
      extra_args --no-deprecation
      no_warnings
    }
  }
  route http://127.0.0.1:${port}/plain {
    command_pass node
  }
}
`;
// Representative payload of the tests below (they use the port of a real upstream).
const payload = manifestPayload(8080);

const saved = { PATH: process.env.PATH, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
let server: http.Server;
let proxy: string;
let port: number;

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  port = (upstream.address() as AddressInfo).port;
  const manifest = join(dir, "manifest.donly");
  writeFileSync(manifest, manifestPayload(port));
  process.env.NO_PROXY = process.env.no_proxy = "";
  process.env.PATH = `${bin}${delimiter}${saved.PATH}`;
  server = createProxyServer(await loadConfig(manifest));
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

const nodeArgs = () => readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
const get = async (path: string) => {
  const res = await fetch(`http://127.0.0.1:${port}/${path}`, { proxy });
  return res.text();
};
const load = (text: string) => {
  const file = join(dir, `v-${Math.random()}.donly`);
  writeFileSync(file, text);
  return loadConfig(file);
};
const route = (body: string) => `proxy {\n  route / {\n${body}\n  }\n}\n`;

testFeature(payload, ["/proxy/route/command_pass/no_warnings"], "should pass --no-warnings to node when command_pass node has no_warnings", async () => {
  expect(await get("flag")).toBe("from upstream");
  expect(nodeArgs()[0]).toBe("--no-warnings");
});

testFeature(payload, ["/proxy/route/command_pass/no_warnings"], "should pass --no-warnings to node with no_warnings true", async () => {
  await get("true");
  expect(nodeArgs()[0]).toBe("--no-warnings");
});

testFeature(payload, ["/proxy/route/command_pass/no_warnings"], "should not pass --no-warnings to node with no_warnings false", async () => {
  await get("false");
  expect(nodeArgs()).not.toContain("--no-warnings");
});

testFeature(payload, ["/proxy/route/command_pass"], "should not pass --no-warnings to node without no_warnings", async () => {
  await get("plain");
  expect(nodeArgs()).not.toContain("--no-warnings");
});

testFeature(payload, ["/proxy/route/command_pass"], "should put no_warnings after the arguments of the line and the extra_args", async () => {
  await get("ordered");
  expect(nodeArgs().slice(0, 3)).toEqual(["--max-old-space-size=64", "--no-deprecation", "--no-warnings"]);
});

testFeature(route(`    command_pass node {\n      no_warnings maybe\n    }`), ["/proxy/route/command_pass/no_warnings"], "should reject a no_warnings that is not true or false", async (text) => {
  await expect(load(text)).rejects.toThrow("no_warnings debe ser true o false");
});

testFeature(route(`    command_pass curl {\n      no_warnings\n    }`), ["/proxy/route/command_pass/no_warnings"], "should reject no_warnings outside command_pass node", async (text) => {
  await expect(load(text)).rejects.toThrow("no_warnings solo aplica a command_pass node");
});

for (const pass of ["ssh_pass myserver", "kubectl_pass pod/api"]) {
  testFeature(
    route(`    ${pass} {\n      command_pass node {\n        no_warnings\n      }\n    }`),
    [`/proxy/route/${pass.split(" ")[0]}/command_pass/no_warnings`],
    `should pass --no-warnings to the node run by ${pass.split(" ")[0]}`,
    async (text) => {
      const [first] = (await load(text)).routes;
      expect(first!.action).toMatchObject({ engine: "node", engineArgs: ["--no-warnings"] });
    },
  );
}
