import { afterAll, beforeAll, expect } from "bun:test";
import type { AddressInfo } from "node:net";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";
import { createUiServer } from "./server";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-ui-"));
const logFile = join(dir, "proxy.ndjson");
const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  log_file "./proxy.ndjson"
}
`;
writeFileSync(logFile, '{"type":"listening","port":1}\n{"type":"request","url":"http://a/"}\n');

const ui = createUiServer(logFile);
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => ui.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(ui.address() as AddressInfo).port}`;
});
afterAll(() => ui.close());

/** Reads SSE `data:` payloads until `count` of them arrive. */
const readEvents = async (count: number, beforeRead?: () => void) => {
  const controller = new AbortController();
  const res = await fetch(`${base}/events`, { signal: controller.signal });
  beforeRead?.();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: string[] = [];
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    const parts = buffer.split("\n\n");
    buffer = parts.pop()!;
    for (const part of parts) if (part.startsWith("data: ")) events.push(part.slice(6));
  }
  controller.abort();
  return { res, events };
};

testFeature(manifestPayload, ["/proxy/log_file"], "should serve the log viewer page on the ui port", async () => {
  const res = await fetch(`${base}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain("EventSource");
});

testFeature(manifestPayload, ["/proxy/log_file"], "should stream the existing log lines and then the new ones as server-sent events", async () => {
  const { res, events } = await readEvents(3, () => {
    setTimeout(() => appendFileSync(logFile, '{"type":"response","status":200}\n'), 150);
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(events.map((line) => JSON.parse(line).type)).toEqual(["listening", "request", "response"]);
});

testFeature(manifestPayload, ["/proxy/log_file"], "should only deliver a log line once it is complete", async () => {
  const { events } = await readEvents(4, () => {
    setTimeout(() => appendFileSync(logFile, '{"type":"resp'), 150);
    setTimeout(() => appendFileSync(logFile, 'onse","status":201}\n'), 400);
  });
  expect(events.at(-1)).toBe('{"type":"response","status":201}');
});

testFeature(manifestPayload, ["/proxy/log_file"], "should answer 404 for unknown ui paths", async () => {
  expect((await fetch(`${base}/nope`)).status).toBe(404);
});

const noLogPayload = `proxy {
  host "127.0.0.1"
  port 0
}
`;
testFeature(noLogPayload, ["/proxy/port"], "should fail --ui with a clear error when the manifest has no log_file", async (payload) => {
  const manifest = join(dir, "no-log.donly");
  writeFileSync(manifest, payload);
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../cli/main.ts"), manifest, "--ui"], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = [await proc.exited, await new Response(proc.stderr).text()];
  expect(code).toBe(1);
  expect(stderr).toContain("--ui requiere log_file");
}, 5000);
