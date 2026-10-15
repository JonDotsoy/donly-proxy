import { afterAll, beforeAll, expect } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "../../server";
import { testFeature } from "../../../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-curl-"));
const bin = join(dir, "bin");
const argsFile = join(dir, "curl.args");
const stdinFile = join(dir, "curl.stdin");

// A fake `curl` that records how it was called and answers the way curl would
// with the flags the proxy passes: body on stdout, "<status>\n<header_json>" on stderr.
mkdirSync(bin);
writeFileSync(
  join(bin, "curl"),
  `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
cat > "${stdinFile}"
printf '201\\n{"x-fake-curl":["yes"],"content-type":["text/plain"]}' >&2
printf 'answered by fake curl'
`,
);
chmodSync(join(bin, "curl"), 0o755);

const manifest = join(dir, "manifest.donly");
const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  ssl {
    cert "./certs/cert.pem"
    key "./certs/key.pem"
  }
  route http://fake.test/* {
    command_pass curl "--max-time" "5"
  }
}
`;
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

testFeature(manifestPayload, ["/proxy/route/command_pass"], "command_pass curl runs the curl found in PATH", async () => {
  const res = await fetch("http://fake.test/some/path?q=1", {
    proxy,
    method: "POST",
    body: "payload",
    headers: { "x-custom": "abc" },
  });

  // The response is exactly what the fake script printed.
  expect(res.status).toBe(201);
  expect(res.headers.get("x-fake-curl")).toBe("yes");
  expect(await res.text()).toBe("answered by fake curl");

  // The request was handed to the script: URL, method, headers, manifest args and body.
  const args = readFileSync(argsFile, "utf8").split("\n");
  expect(args).toContain("--url");
  expect(args[args.indexOf("--url") + 1]).toBe("http://fake.test/some/path?q=1");
  expect(args[args.indexOf("--request") + 1]).toBe("POST");
  expect(args).toContain("x-custom: abc");
  expect(args.slice(args.indexOf("--max-time"), args.indexOf("--max-time") + 2)).toEqual(["--max-time", "5"]);
  expect(readFileSync(stdinFile, "utf8")).toBe("payload");
});
