import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// End-to-end test of how `route` matches different URL formats: runs the BUILT binary
// (dist/donly-proxy.js) and sends real requests with `curl --proxy`. The port is assigned by the system.
const bundle = resolve(import.meta.dir, "../dist/donly-proxy.js");
const dir = mkdtempSync(join(tmpdir(), "donly-proxy-e2e-urls-"));
const manifestFile = join(dir, "manifest.donly");
writeFileSync(
  manifestFile,
  `proxy {
  listen http 127.0.0.1 0
  route "urlpattern:only.test" {
    respond 200 "host only"
  }
  route "urlpattern:port.test:8080" {
    respond 200 "host and port"
  }
  route "urlpattern:*.wild.test" {
    respond 200 "wildcard"
  }
  route "urlpattern:path.test/api/*" {
    respond 200 "host and path"
  }
  route "urlpattern:https://secure.test/*" {
    respond 200 "https only"
  }
  route "urlpattern:http://plain.test/*" {
    respond 200 "http only"
  }
  route https?://regex.test/ {
    respond 200 "regex"
  }
  route {
    respond 200 "fallback"
  }
}
`,
);

const env = { ...process.env, NO_PROXY: "", no_proxy: "" };
let child: ReturnType<typeof Bun.spawn>;
let port = "";

const get = async (url: string) => {
  const proc = Bun.spawn(["curl", "-sS", "-k", "--max-time", "4", "--proxy", `http://127.0.0.1:${port}`, url], { stdout: "pipe", stderr: "pipe", env });
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
    port = out.match(/proxy listening on 127\.0\.0\.1:(\d+)/)?.[1] ?? "";
  }
});
afterAll(() => child?.kill());

test("a host-only urlpattern matches any scheme, path and query", async () => {
  expect(await get("http://only.test/")).toBe("host only");
  expect(await get("http://only.test/a/b?x=1")).toBe("host only");
  expect(await get("https://only.test/a")).toBe("host only");
  expect(await get("http://sub.only.test/")).toBe("fallback");
});

test("a host with port urlpattern matches only that port", async () => {
  expect(await get("http://port.test:8080/x")).toBe("host and port");
  expect(await get("http://port.test:9090/x")).toBe("fallback");
  expect(await get("http://port.test/x")).toBe("fallback");
});

test("a urlpattern with wildcards matches subdomains and paths", async () => {
  expect(await get("http://a.wild.test/")).toBe("wildcard");
  expect(await get("http://a.b.wild.test/")).toBe("wildcard");
  expect(await get("http://wild.test/")).toBe("fallback");
  expect(await get("http://path.test/api/users/1")).toBe("host and path");
  expect(await get("http://path.test/other")).toBe("fallback");
});

test("a urlpattern with a scheme only matches that protocol", async () => {
  expect(await get("https://secure.test/a")).toBe("https only");
  expect(await get("http://secure.test/a")).toBe("fallback");
  expect(await get("http://plain.test/a")).toBe("http only");
  expect(await get("https://plain.test/a")).toBe("fallback");
});

test("a pattern without the prefix keeps working as a regular expression", async () => {
  expect(await get("http://regex.test/")).toBe("regex");
  expect(await get("https://regex.test/")).toBe("regex");
});
