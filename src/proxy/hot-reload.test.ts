import { afterEach, expect } from "bun:test";
import { createServer, connect, type AddressInfo } from "node:net";
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

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const answerOn = async (port: number) =>
  (await fetch("http://example.invalid/", { proxy: `http://127.0.0.1:${port}` })).text();

const isClosed = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.on("connect", () => (socket.destroy(), resolve(false)));
    socket.on("error", () => resolve(true));
  });

const portsOf = (runner: ManifestRunner) => runner.servers().map((s) => (s.address() as AddressInfo).port);

const listenPayload = (ports: number[], body: string) =>
  ports.map((port, i) => `proxy {\n  listen http 127.0.0.1 ${port}\n  route {\n    respond 200 "${body}${i}"\n  }\n}\n`).join("");

testFeature(manifestPayload("v1"), ["/proxy/route/respond"], "should answer each request with the manifest saved right before it", async () => {
  const file = join(dir, "reload-sequence.donly");
  writeFileSync(file, manifestPayload("v1"));
  const m = messages();
  runner = await runManifest(file, { log: m.log });
  for (const version of ["v1", "v2", "v3", "v4"]) {
    if (version !== "v1") {
      const reloaded = m.info.filter((line) => line.includes("recargado")).length;
      writeFileSync(file, manifestPayload(version));
      await until(() => m.info.filter((line) => line.includes("recargado")).length > reloaded);
    }
    expect(await ask(runner)).toBe(version);
  }
});

testFeature(manifestPayload("v1"), ["/proxy/listen"], "should release the old port and listen on the new one when the manifest changes the port", async () => {
  const [oldPort, newPort] = [await freePort(), await freePort()];
  const file = join(dir, "reload-port.donly");
  writeFileSync(file, listenPayload([oldPort], "old"));
  const m = messages();
  runner = await runManifest(file, { log: m.log });
  expect(await answerOn(oldPort)).toBe("old0");
  writeFileSync(file, listenPayload([newPort], "new"));
  await until(() => m.info.some((line) => line.includes("recargado")));
  expect(await answerOn(newPort)).toBe("new0");
  // No orphan: nothing keeps listening on the old port and only the new server is alive.
  expect(await isClosed(oldPort)).toBe(true);
  expect(portsOf(runner)).toEqual([newPort]);
});

testFeature(manifestPayload("v1"), ["/proxy", "/proxy/listen"], "should reload several proxies and listeners and validate every port", async () => {
  const first = [await freePort(), await freePort()];
  const second = [await freePort()];
  const file = join(dir, "reload-multi.donly");
  const payload = (a: number[], b: number[], body: string) =>
    `proxy {\n${a.map((p) => `  listen http 127.0.0.1 ${p}\n`).join("")}  route {\n    respond 200 "${body}-a"\n  }\n}\nproxy {\n${b.map((p) => `  listen http 127.0.0.1 ${p}\n`).join("")}  route {\n    respond 200 "${body}-b"\n  }\n}\n`;
  writeFileSync(file, payload(first, second, "v1"));
  const m = messages();
  runner = await runManifest(file, { log: m.log });
  expect(portsOf(runner)).toEqual([...first, ...second]);
  expect(await Promise.all([...first, ...second].map(answerOn))).toEqual(["v1-a", "v1-a", "v1-b"]);

  const next = [await freePort(), await freePort()];
  writeFileSync(file, payload([first[0]!], next, "v2"));
  await until(() => m.info.some((line) => line.includes("recargado")));
  expect(portsOf(runner)).toEqual([first[0]!, ...next]);
  expect(await Promise.all([first[0]!, ...next].map(answerOn))).toEqual(["v2-a", "v2-b", "v2-b"]);
  // The listeners that left the manifest are gone.
  expect(await Promise.all([first[1]!, ...second].map(isClosed))).toEqual([true, true]);
});
