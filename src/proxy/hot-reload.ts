import { readFileSync, watch } from "node:fs";
import type http from "node:http";
import type { AddressInfo, Server } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { lintManifestFile } from "./lint";
import { createProxyServers, loadConfigs, type ProxyConfig } from "./server";

export interface ManifestRunnerOptions {
  /** Watch the manifest and apply its changes without restarting (default `true`). */
  reload?: boolean;
  log?: { info: (message: string) => void; error: (message: string) => void };
}

export interface ManifestRunner {
  /** The servers currently listening, in manifest order. */
  servers: () => Server[];
  close: () => Promise<void>;
}

const describe = (listener: { socks?: 4 | 5; https?: unknown }) =>
  listener.socks ? `socks${listener.socks}` : listener.https ? "https" : "http";

const listenAll = async (configs: ProxyConfig[], log: Required<ManifestRunnerOptions>["log"]) => {
  const servers: Server[] = [];
  try {
    for (const config of configs) {
      const created = createProxyServers(config);
      for (const [i, server] of created.entries()) {
        const listener = config.listeners[i]!;
        servers.push(server);
        await new Promise<void>((done, fail) => {
          server.once("error", (error: NodeJS.ErrnoException) =>
            fail(new Error(`no se pudo escuchar en ${listener.host}:${listener.port}: ${error.code ?? error.message}`)),
          );
          server.listen(listener.port, listener.host, () => {
            // `port 0` is assigned by the system: report the real one.
            log.info(`proxy listening on ${listener.host}:${(server.address() as AddressInfo).port} (${describe(listener)})`);
            done();
          });
        });
      }
    }
  } catch (error) {
    await closeAll(servers);
    throw error;
  }
  return servers;
};

const closeAll = (servers: Server[]) =>
  Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((done) => {
          server.close(() => done());
          (server as http.Server).closeIdleConnections?.();
        }),
    ),
  ).then(() => undefined);

/**
 * Starts the proxies of a manifest and, unless `reload` is `false`, re-applies the manifest whenever the file changes.
 * A reload re-binds the listeners; if the new manifest is invalid or cannot listen, the previous one keeps running.
 * Rejects when the first start fails.
 */
export const runManifest = async (
  manifest: string,
  { reload = true, log = { info: console.log, error: console.error } }: ManifestRunnerOptions = {},
): Promise<ManifestRunner> => {
  const path = resolve(manifest);
  const read = () => readFileSync(path, "utf8");
  let configs = await loadConfigs(path);
  let servers = await listenAll(configs, log);
  let source = read();
  let queue = Promise.resolve();

  const apply = async () => {
    try {
      const next = read();
      if (next === source) return;
      source = next;
      if (!(await lintManifestFile(path, log.error))) throw new Error("el manifiesto tiene errores");
      const nextConfigs = await loadConfigs(path);
      await closeAll(servers);
      try {
        servers = await listenAll(nextConfigs, log);
      } catch (error) {
        servers = await listenAll(configs, log);
        throw error;
      }
      configs = nextConfigs;
      log.info(`manifiesto recargado: ${path}`);
    } catch (error) {
      log.error(`Error: no se pudo recargar ${path}: ${(error as Error).message}; se conserva la configuración anterior`);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  // Editors save by renaming over the file, so the directory is watched instead of the file itself.
  const watcher = reload
    ? watch(dirname(path), (_event, filename) => {
        if (filename && filename !== basename(path)) return;
        clearTimeout(timer);
        timer = setTimeout(() => void (queue = queue.then(apply)), 100);
      })
    : undefined;

  return {
    servers: () => servers,
    close: async () => {
      clearTimeout(timer);
      watcher?.close();
      await queue;
      await closeAll(servers);
    },
  };
};
