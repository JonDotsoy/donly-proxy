import { afterAll, beforeAll, expect } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-logcmd-"));
const bin = join(dir, "bin");
const logFile = join(dir, "proxy.ndjson");

// Fake curl / ssh / kubectl that answer like curl does (body on stdout, status and
// headers on stderr), whatever they are asked to run.
mkdirSync(bin);
for (const name of ["curl", "ssh", "kubectl"]) {
  writeFileSync(join(bin, name), `#!/bin/sh\ncat > /dev/null\nprintf '200\\n{"content-type":["text/plain"]}' >&2\nprintf 'from ${name}'\n`);
  chmodSync(join(bin, name), 0o755);
}

// A real upstream for the `node` command, which performs the request itself.
const upstream = http.createServer((_req, res) => res.end("from upstream"));

const manifestPayload = (port: number) => `proxy {
  host "127.0.0.1"
  port 0
  log_file "./proxy.ndjson"
  route http://logcmd.test/curl {
    command_pass curl "--max-time" "5"
  }
  route http://127.0.0.1:${port}/node {
    command_pass node "--no-warnings"
  }
  route http://logcmd.test/ssh {
    command_pass ssh "-p" "2222" "user@remote.test"
  }
  route http://logcmd.test/via-ssh-pass {
    ssh_pass logged-host "-v" {
      port 2200
      user deploy
      pass "top-secret"
      command_pass curl "--max-time" "5"
    }
  }
  route http://logcmd.test/kubectl {
    command_pass kubectl "-n" "prod" "deploy/api"
  }
  route http://logcmd.test/respond {
    respond 200 "plain"
  }
}
`;

// Representative payload of the tests below (the node route uses the port of a real upstream).
const payload = manifestPayload(8080);

const saved = { PATH: process.env.PATH, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
let server: http.Server;
let proxy: string;
let upstreamPort: number;

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
  writeFileSync(join(dir, "manifest.donly"), manifestPayload(upstreamPort));
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

const readLog = (): any[] => {
  try {
    return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

/** Makes a request and returns the `request` and `response` log lines it produced. */
const logged = async (url: string) => {
  const before = readLog().length;
  await (await fetch(url, { proxy })).text();
  const [request, response] = readLog().slice(before);
  return { request, response };
};

testFeature(payload, ["/proxy/log_file", "/proxy/route/command_pass"], "logs the curl command that was executed", async () => {
  const { request, response } = await logged("http://logcmd.test/curl?x=1");
  expect(request.type).toBe("request");
  expect(response.type).toBe("response");
  expect(response.command[0]).toBe("curl");
  expect(response.command).toContain("--max-time");
  expect(response.command.slice(-2)).toEqual(["--url", "http://logcmd.test/curl?x=1"]);
});

testFeature(payload, ["/proxy/log_file", "/proxy/route/command_pass"], "logs the node command that was executed", async () => {
  const { response } = await logged(`http://127.0.0.1:${upstreamPort}/node`);
  expect(await Promise.resolve(response.status)).toBe(200);
  expect(response.command[0]).toBe("node");
  expect(response.command[1]).toBe("--no-warnings");
  expect(response.command[2]).toEndWith("node-request.mjs");
});

testFeature(payload, ["/proxy/log_file", "/proxy/route/command_pass"], "logs the ssh command that was executed, including the remote command", async () => {
  const { response } = await logged("http://logcmd.test/ssh");
  expect(response.command.slice(0, 2)).toEqual(["ssh", "-p"]);
  expect(response.command).toContain("user@remote.test");
  expect(response.command.at(-1)).toContain("curl -K");
});

testFeature(payload, ["/proxy/log_file", "/proxy/route/command_pass"], "logs the kubectl command that was executed", async () => {
  const { response } = await logged("http://logcmd.test/kubectl");
  expect(response.command.slice(0, 3)).toEqual(["kubectl", "exec", "-i"]);
  expect(response.command).toContain("deploy/api");
  expect(response.command).toContain("--");
});

testFeature(payload, ["/proxy/log_file", "/proxy/route/respond"], "routes without command_pass log no command", async () => {
  const { request, response } = await logged("http://logcmd.test/respond");
  expect(request).not.toHaveProperty("command");
  expect(response).not.toHaveProperty("command");
  const fallback = await logged("http://unmatched.test/");
  expect(fallback.response).not.toHaveProperty("command");
});

testFeature(payload, ["/proxy/log_file", "/proxy/route/ssh_pass"], "logs the ssh command of ssh_pass with its arguments, without the password", async () => {
  const { request, response } = await logged("http://logcmd.test/via-ssh-pass?x=1");
  expect(request.type).toBe("request");
  expect(response.type).toBe("response");
  // ssh options (given, port, user), the host, then the remote command with the curl options.
  expect(response.command.slice(0, 7)).toEqual(["ssh", "-v", "-p", "2200", "-l", "deploy", "-T"]);
  expect(response.command).toContain("logged-host");
  expect(response.command.indexOf("logged-host")).toBe(response.command.length - 2);
  expect(response.command.at(-1)).toContain("curl -K");
  expect(response.command.at(-1)).toContain("'--max-time' '5'");
  // The password goes to ssh through the environment: it is not in the logged command.
  expect(JSON.stringify(response)).not.toContain("top-secret");
});
