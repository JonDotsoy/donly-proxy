import { afterEach, expect } from "bun:test";
import { createServer, connect, type AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";
import { runManifest, type ManifestRunner } from "./hot-reload";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-hot-reload-"));

/** A manifest with one proxy that answers `body`; `port 0` unless `ports` are given (one `listen` each). */
const proxyBlock = (body: string, ports: number[] = []) => `proxy {
${ports.length > 0 ? ports.map((port) => `  listen http 127.0.0.1 ${port}\n`).join("") : '  host "127.0.0.1"\n  port 0\n'}  route {
    respond 200 "${body}"
  }
}
`;

const invalidManifest = `proxy {
  route {
    respond 200 "x"
    respond 201 "y"
  }
}
`;

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (check: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !check(); await sleep(20)) {
    if (Date.now() > end) throw new Error("timeout waiting for the reload");
  }
};

/** What the proxy answers on `port`. */
const answerOn = async (port: number) => (await fetch("http://example.invalid/", { proxy: `http://127.0.0.1:${port}` })).text();

const isClosed = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.on("connect", () => (socket.destroy(), resolve(false)));
    socket.on("error", () => resolve(true));
  });

const running: ManifestRunner[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((runner) => runner.close()));
});

/** Starts `manifest` the way the CLI does and returns the verbs the tests read like. */
const startProxy = async (name: string, manifest: string, options: { reload?: boolean } = {}) => {
  const file = join(dir, `${name}.donly`);
  writeFileSync(file, manifest);
  const info: string[] = [];
  const errors: string[] = [];
  const runner = await runManifest(file, { ...options, log: { info: (m) => void info.push(m), error: (m) => void errors.push(m) } });
  running.push(runner);
  const outcomes = () => info.filter((line) => line.includes("recargado")).length + errors.filter((line) => line.includes("se conserva")).length;
  const ports = () => runner.servers().map((server) => (server.address() as AddressInfo).port);
  return {
    ports,
    errors,
    /** Answer of the first listener. */
    answer: () => answerOn(ports()[0]!),
    reloads: () => info.filter((line) => line.includes("recargado")).length,
    /** Saves the manifest without waiting for anything. */
    saveManifest: (text: string) => writeFileSync(file, text),
    /** Saves the manifest and waits until the proxy applied it or rejected it. */
    updateManifest: async (text: string) => {
      const before = outcomes();
      writeFileSync(file, text);
      await until(() => outcomes() > before);
    },
  };
};

testFeature(proxyBlock("v1"), ["/proxy/route/respond"], "should apply the new routes when the manifest changes", async () => {
  const proxy = await startProxy("reload-ok", proxyBlock("v1"));
  expect(await proxy.answer()).toBe("v1");
  await proxy.updateManifest(proxyBlock("v2"));
  expect(await proxy.answer()).toBe("v2");
});

testFeature(proxyBlock("v1"), ["/proxy/route/respond"], "should answer each request with the manifest saved right before it", async () => {
  const proxy = await startProxy("reload-sequence", proxyBlock("v1"));
  for (const version of ["v1", "v2", "v3", "v4"]) {
    if (version !== "v1") await proxy.updateManifest(proxyBlock(version));
    expect(await proxy.answer()).toBe(version);
  }
});

testFeature(proxyBlock("v1"), ["/proxy/route/respond"], "should keep the previous config and report the error when the new manifest is invalid", async () => {
  const proxy = await startProxy("reload-invalid", proxyBlock("v1"));
  await proxy.updateManifest(invalidManifest);
  expect(proxy.reloads()).toBe(0);
  expect(proxy.errors.some((line) => line.includes("se conserva la configuración anterior"))).toBe(true);
  expect(await proxy.answer()).toBe("v1");
  // It recovers on the next valid save.
  await proxy.updateManifest(proxyBlock("v2"));
  expect(await proxy.answer()).toBe("v2");
});

testFeature(proxyBlock("v1"), ["/proxy/route/respond"], "should not watch the manifest when reload is disabled", async () => {
  const proxy = await startProxy("reload-off", proxyBlock("v1"), { reload: false });
  proxy.saveManifest(proxyBlock("v2"));
  await sleep(600);
  expect(proxy.reloads()).toBe(0);
  expect(await proxy.answer()).toBe("v1");
});

testFeature(proxyBlock("old", [1]), ["/proxy/listen"], "should release the old port and listen on the new one when the manifest changes the port", async () => {
  const [oldPort, newPort] = [await freePort(), await freePort()];
  const proxy = await startProxy("reload-port", proxyBlock("old", [oldPort]));
  expect(await answerOn(oldPort)).toBe("old");
  await proxy.updateManifest(proxyBlock("new", [newPort]));
  expect(await answerOn(newPort)).toBe("new");
  // No orphan: nothing keeps listening on the old port and only the new server is alive.
  expect(await isClosed(oldPort)).toBe(true);
  expect(proxy.ports()).toEqual([newPort]);
});

testFeature(proxyBlock("a", [1, 2]) + proxyBlock("b", [3]), ["/proxy", "/proxy/listen"], "should reload several proxies and listeners and validate every port", async () => {
  const [a1, a2, b1, b1Next, b2Next] = await Promise.all(Array.from({ length: 5 }, freePort));
  const proxy = await startProxy("reload-multi", proxyBlock("v1-a", [a1!, a2!]) + proxyBlock("v1-b", [b1!]));
  expect(proxy.ports()).toEqual([a1!, a2!, b1!]);
  expect(await Promise.all(proxy.ports().map(answerOn))).toEqual(["v1-a", "v1-a", "v1-b"]);

  await proxy.updateManifest(proxyBlock("v2-a", [a1!]) + proxyBlock("v2-b", [b1Next!, b2Next!]));
  expect(proxy.ports()).toEqual([a1!, b1Next!, b2Next!]);
  expect(await Promise.all(proxy.ports().map(answerOn))).toEqual(["v2-a", "v2-b", "v2-b"]);
  // The listeners that left the manifest are gone.
  expect(await Promise.all([a2!, b1!].map(isClosed))).toEqual([true, true]);
});

testFeature(proxyBlock("v1", [1]), ["/proxy/listen"], "should add and then remove a listener keeping the others alive", async () => {
  const [port1, port2] = [await freePort(), await freePort()];
  const proxy = await startProxy("reload-add-remove-listener", proxyBlock("v1", [port1]));
  expect(await answerOn(port1)).toBe("v1");
  expect(await isClosed(port2)).toBe(true);

  // A second listener: both ports are alive and answer the same.
  await proxy.updateManifest(proxyBlock("v2", [port1, port2]));
  expect(proxy.ports()).toEqual([port1, port2]);
  expect(await answerOn(port1)).toBe("v2");
  expect(await answerOn(port2)).toBe("v2");

  // The second listener leaves: port 1 stays alive, port 2 fails.
  await proxy.updateManifest(proxyBlock("v3", [port1]));
  expect(proxy.ports()).toEqual([port1]);
  expect(await answerOn(port1)).toBe("v3");
  expect(await isClosed(port2)).toBe(true);
  await expect(answerOn(port2)).rejects.toThrow();
});
