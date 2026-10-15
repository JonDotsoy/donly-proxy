import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// End-to-end test of a `proxy` block without any `route`: runs the BUILT binary (dist/donly-proxy.js)
// and checks it with the real `curl --proxy`. The port is assigned by the system and read from stdout.
const bundle = resolve(import.meta.dir, "../dist/donly-proxy.js");
const dir = mkdtempSync(join(tmpdir(), "donly-proxy-e2e-no-route-"));
const manifestFile = join(dir, "manifest.donly");
writeFileSync(
  manifestFile,
  `proxy {
  listen http 127.0.0.1 0
}
`,
);

const env = { ...process.env, NO_PROXY: "", no_proxy: "" };
let child: ReturnType<typeof Bun.spawn>;
let port = "";

const curl = async (...args: string[]) => {
  const proc = Bun.spawn(["curl", "-sS", "-i", "--max-time", "4", "--proxy", `http://127.0.0.1:${port}`, ...args], { stdout: "pipe", stderr: "pipe", env });
  return new Response(proc.stdout).text();
};

beforeAll(async () => {
  child = Bun.spawn(["bun", bundle, manifestFile], { cwd: dir, stdout: "pipe", stderr: "inherit", env });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (!port) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
    port = out.match(/proxy listening on 127\.0\.0\.1:(\d+) \(http\)/)?.[1] ?? "";
  }
});
afterAll(() => child?.kill());

test("a proxy without route starts and answers every request with the default '200 ok'", async () => {
  expect(port).not.toBe("");
  for (const url of ["http://example.com/", "http://example.org/a/b?x=1"]) {
    const res = await curl(url);
    expect(res).toStartWith("HTTP/1.1 200 OK");
    expect(res.endsWith("\r\n\r\nok")).toBe(true);
  }
});
