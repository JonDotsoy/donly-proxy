import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// End-to-end test of several `proxy` blocks: runs the BUILT binary (dist/donly-proxy.js) and checks
// each listener with the real `curl --proxy`. Ports are assigned by the system and read from stdout.
const bundle = resolve(import.meta.dir, "../dist/donly-proxy.js");
const dir = mkdtempSync(join(tmpdir(), "donly-proxy-e2e-multi-"));
const manifestFile = join(dir, "manifest.donly");
writeFileSync(
  manifestFile,
  `proxy {
  listen http 127.0.0.1 0
  route {
    respond 200 "ok http"
  }
}
proxy {
  listen https 127.0.0.1 0
  route {
    respond 200 "ok https"
  }
}
`,
);

const env = { ...process.env, NO_PROXY: "", no_proxy: "" };
let child: ReturnType<typeof Bun.spawn>;
const ports: Record<string, string> = {};

const curl = async (...args: string[]) => {
  const proc = Bun.spawn(["curl", "-sS", "-k", "--proxy-insecure", "--max-time", "4", ...args], { stdout: "pipe", stderr: "pipe", env });
  return new Response(proc.stdout).text();
};

beforeAll(async () => {
  child = Bun.spawn(["bun", bundle, manifestFile], { cwd: dir, stdout: "pipe", stderr: "inherit", env });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (Object.keys(ports).length < 2) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
    for (const [, port, scheme] of out.matchAll(/proxy listening on 127\.0\.0\.1:(\d+) \((\w+)\)/g)) ports[scheme!] = port!;
  }
});
afterAll(() => child?.kill());

test("curl --proxy http:// answers 'ok http' and curl --proxy https:// answers 'ok https'", async () => {
  expect(ports.http).toBeDefined();
  expect(ports.https).toBeDefined();
  expect(await curl("--proxy", `http://127.0.0.1:${ports.http}`, "http://example.com/")).toBe("ok http");
  expect(await curl("--proxy", `https://127.0.0.1:${ports.https}`, "http://example.com/")).toBe("ok https");
});
