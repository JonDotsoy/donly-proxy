import { afterEach, expect } from "bun:test";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";
import { runManifest, type ManifestRunner } from "./hot-reload";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-hot-reload-"));
const manifestPayload = (body: string) => `proxy {
  host "127.0.0.1"
  port 0
  route {
    respond 200 "${body}"
  }
}
`;

let runner: ManifestRunner | undefined;
afterEach(async () => {
  await runner?.close();
  runner = undefined;
});

const messages = () => {
  const info: string[] = [];
  const error: string[] = [];
  return { info, error, log: { info: (m: string) => void info.push(m), error: (m: string) => void error.push(m) } };
};

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timeout waiting for the reload");
    await new Promise((r) => setTimeout(r, 20));
  }
};

const ask = async (runner: ManifestRunner) => {
  const { port } = runner.servers()[0]!.address() as AddressInfo;
  const res = await fetch("http://example.invalid/", { proxy: `http://127.0.0.1:${port}` });
  return res.text();
};

testFeature(manifestPayload("v1"), ["/proxy/route/respond"], "should apply the new routes when the manifest changes", async () => {
  const file = join(dir, "reload-ok.donly");
  writeFileSync(file, manifestPayload("v1"));
  const m = messages();
  runner = await runManifest(file, { log: m.log });
  expect(await ask(runner)).toBe("v1");
  writeFileSync(file, manifestPayload("v2"));
  await until(() => m.info.some((line) => line.includes("recargado")));
  expect(await ask(runner)).toBe("v2");
});

testFeature(manifestPayload("v1"), ["/proxy/route/respond"], "should keep the previous config and report the error when the new manifest is invalid", async () => {
  const file = join(dir, "reload-invalid.donly");
  writeFileSync(file, manifestPayload("v1"));
  const m = messages();
  runner = await runManifest(file, { log: m.log });
  writeFileSync(file, "proxy {\n  route {\n    respond 200 \"x\"\n    respond 201 \"y\"\n  }\n}\n");
  await until(() => m.error.some((line) => line.includes("se conserva la configuración anterior")));
  expect(m.info.some((line) => line.includes("recargado"))).toBe(false);
  expect(await ask(runner)).toBe("v1");
});

testFeature(manifestPayload("v1"), ["/proxy/route/respond"], "should not watch the manifest when reload is disabled", async () => {
  const file = join(dir, "reload-off.donly");
  writeFileSync(file, manifestPayload("v1"));
  const m = messages();
  runner = await runManifest(file, { log: m.log, reload: false });
  writeFileSync(file, manifestPayload("v2"));
  await new Promise((r) => setTimeout(r, 600));
  expect(m.info.some((line) => line.includes("recargado"))).toBe(false);
  expect(await ask(runner)).toBe("v1");
});
