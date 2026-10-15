import { afterAll, beforeAll, expect } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createProxyServer, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-concurrency-"));
const bin = join(dir, "bin");
const eventsFile = join(dir, "events");
const failNext = join(dir, "fail-next");

// A fake `curl` that takes 300ms and records when each run starts and ends (with its URL).
// If `fail-next` exists, the next run consumes it and fails.
mkdirSync(bin);
writeFileSync(
  join(bin, "curl"),
  `#!/bin/sh
while [ "$1" != "--url" ]; do shift; done
url="$2"
echo "start $url" >> "${eventsFile}"
sleep 0.3
echo "end $url" >> "${eventsFile}"
if [ -e "${failNext}" ]; then rm -f "${failNext}"; echo 'boom' >&2; exit 1; fi
printf '200\\n{"content-type":["text/plain"]}' >&2
printf 'done'
`,
);
chmodSync(join(bin, "curl"), 0o755);

const manifest = join(dir, "manifest.donly");
const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  route http://conc.test/default/* {
    command_pass curl
  }
  route http://conc.test/two/* {
    command_pass curl {
      concurrency 2
    }
  }
}
`;
writeFileSync(manifest, manifestPayload);

const savedPath = process.env.PATH;
let server: Server;
let proxy: string;

beforeAll(async () => {
  process.env.PATH = `${bin}${delimiter}${savedPath}`;
  server = createProxyServer(await loadConfig(manifest));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  process.env.PATH = savedPath;
  server.close();
});

const reset = () => writeFileSync(eventsFile, "");
const events = () => readFileSync(eventsFile, "utf8").split("\n").filter(Boolean);
const maxRunning = () => {
  let running = 0;
  let max = 0;
  for (const event of events()) {
    running += event.startsWith("start") ? 1 : -1;
    max = Math.max(max, running);
  }
  return max;
};
const get = (path: string, delay = 0) =>
  new Promise<Response>((resolve, reject) =>
    setTimeout(() => fetch(`http://conc.test${path}`, { proxy }).then(resolve, reject), delay),
  );

testFeature(manifestPayload, ["/proxy/route/command_pass"], "runs one process at a time by default", async () => {
  reset();
  const started = Date.now();
  const responses = await Promise.all([get("/default/a"), get("/default/b"), get("/default/c")]);
  expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
  expect(maxRunning()).toBe(1);
  expect(events()).toHaveLength(6);
  expect(Date.now() - started).toBeGreaterThanOrEqual(850); // 3 × 300ms, one after the other
});

testFeature(manifestPayload, ["/proxy/route/command_pass/concurrency"], "concurrency <n> allows n processes in parallel", async () => {
  reset();
  const started = Date.now();
  const responses = await Promise.all([get("/two/a"), get("/two/b"), get("/two/c"), get("/two/d")]);
  expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
  expect(maxRunning()).toBe(2);
  expect(Date.now() - started).toBeLessThan(1100); // 4 runs in 2 waves of 300ms (one after the other would take 1200ms)
});

testFeature(manifestPayload, ["/proxy/route/command_pass"], "each route has its own limit", async () => {
  reset();
  await Promise.all([get("/default/a"), get("/two/a"), get("/two/b")]);
  expect(maxRunning()).toBe(3);
});

testFeature(manifestPayload, ["/proxy/route/command_pass"], "waiting requests are served in arrival order", async () => {
  reset();
  await Promise.all([get("/default/1", 0), get("/default/2", 60), get("/default/3", 120)]);
  expect(events().filter((e) => e.startsWith("start"))).toEqual([
    "start http://conc.test/default/1",
    "start http://conc.test/default/2",
    "start http://conc.test/default/3",
  ]);
});

testFeature(manifestPayload, ["/proxy/route/command_pass"], "a failing process frees its place for the next request", async () => {
  reset();
  writeFileSync(failNext, "");
  const responses = await Promise.all([get("/default/a"), get("/default/b", 60)]);
  expect(responses.map((r) => r.status)).toEqual([502, 200]);
  expect(await responses[1]!.text()).toBe("done");
  expect(maxRunning()).toBe(1);
  expect(existsSync(failNext)).toBe(false);
});

testFeature(manifestPayload, ["/proxy/route/command_pass/concurrency"], "loadConfig reads concurrency, defaulting to 1", async () => {
  const config = await loadConfig(manifest);
  const concurrency = config.routes.map((r) => (r.action.kind === "command_pass" ? r.action.concurrency : undefined));
  expect(concurrency).toEqual([1, 2]);
});

const concurrencyPayload = (value: string) => `proxy {\n  route / {\n    command_pass curl {\n      concurrency ${value}\n    }\n  }\n}\n`;

testFeature(concurrencyPayload("0"), ["/proxy/route/command_pass/concurrency"], "concurrency must be a positive integer", async () => {
  const load = (value: string) => {
    const file = join(dir, `v-${Math.random()}.donly`);
    writeFileSync(file, concurrencyPayload(value));
    return loadConfig(file);
  };
  for (const value of ["0", "-1", "1.5", "many"]) {
    expect(load(value)).rejects.toThrow("concurrency debe ser un entero positivo");
  }
});
