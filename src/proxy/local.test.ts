import { afterAll, beforeAll, expect } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const target = "http://localhost:3001/hello";

// Local server on :3001
const local = http.createServer((_req, res) => res.end("hello from 3001"));

// Manifest without any `route`
const dir = mkdtempSync(join(tmpdir(), "donly-proxy-local-"));
const manifest = join(dir, "manifest.donly");
const logFile = join(dir, "proxy.ndjson");
const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  log_file "./proxy.ndjson"
  ssl {
    cert "./certs/cert.pem"
    key "./certs/key.pem"
  }
}
`;
writeFileSync(manifest, manifestPayload);

let server: ReturnType<typeof createProxyServer>;
let proxy: string;

beforeAll(async () => {
  // fetch skips an explicit `proxy` for hosts listed in NO_PROXY (often "localhost").
  for (const name of ["NO_PROXY", "no_proxy"]) process.env[name] = "";
  await new Promise<void>((resolve) => local.listen(3001, "127.0.0.1", resolve));
  server = createProxyServer(await loadConfig(manifest));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  local.close();
});

const readLog = () =>
  existsSync(logFile)
    ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

testFeature(manifestPayload, ["/proxy/log_file"], "fetch without proxy reaches the local server and writes no request log", async () => {
  const res = await fetch(target);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("hello from 3001");
  // The proxy only logged that it started listening.
  expect(readLog().map((l) => l.type)).toEqual(["listening"]);
});

testFeature(manifestPayload, ["/proxy/log_file"], "fetch through the proxy goes through it and is logged", async () => {
  const res = await fetch(target, { proxy });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("hello from 3001"); // no route: the request is forwarded as-is

  const [listening, request, response] = readLog();
  expect(readLog()).toHaveLength(3);
  expect(listening.type).toBe("listening");
  expect(request.type).toBe("request");
  expect(request.method).toBe("GET");
  expect(request.url).toBe(target);
  expect(response.type).toBe("response");
  expect(response.url).toBe(target);
  expect(response.transaction_id).toBe(request.transaction_id);
});

testFeature(manifestPayload, ["/proxy/log_file"], "a later fetch without proxy still adds nothing to the log", async () => {
  const before = readLog().length;
  expect(await (await fetch(target)).text()).toBe("hello from 3001");
  expect(readLog()).toHaveLength(before);
});
