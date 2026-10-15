import type { AddressInfo } from "node:net";
import { argument, flag, flags } from "@jondotsoy/flags";
import pkg from "../../package.json";
import { lintManifestFile } from "../proxy/lint";
import { createProxyServers, loadConfig } from "../proxy/server";
import { createUiServer } from "../ui/server";

const parser = flags({
  help: flag("--help", "-h").boolean().describe("Muestra esta ayuda"),
  version: flag("--version", "-V").boolean().describe("Muestra la versión"),
  ui: flag("--ui").boolean().describe("Levanta una página con los logs en vivo (requiere log_file)"),
  uiPort: flag("--ui-port").number().default(8081).describe("Puerto de la página de logs (por defecto 8081)"),
  manifest: argument().string().describe("Ruta al manifiesto .donly (por defecto manifest.donly)"),
})
  .program("donly-proxy")
  .describe("Servidor proxy HTTP/HTTPS");

let options: ReturnType<typeof parser.parse>;
try {
  options = parser.parse(process.argv.slice(2));
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  console.log(parser.helpMessage());
  process.exit(1);
}

if (options.help) {
  console.log(parser.helpMessage());
  process.exit(0);
}

if (options.version) {
  console.log(pkg.version);
  process.exit(0);
}

// Lint errors abort the start; warnings are printed and let it continue.
if (!(await lintManifestFile(options.manifest ?? new URL("../../manifest.donly", import.meta.url)))) {
  process.exit(1);
}

const config = await loadConfig(options.manifest);
if (options.ui && !config.logFile) {
  console.error("Error: --ui requiere log_file en el manifiesto para poder mostrar los logs");
  process.exit(1);
}
const servers = createProxyServers(config);
const failed = (listener: { host: string; port: number }) => (error: NodeJS.ErrnoException) => {
  console.error(`Error: no se pudo escuchar en ${listener.host}:${listener.port}: ${error.code ?? error.message}`);
  process.exit(1);
};
for (const [i, server] of servers.entries()) {
  const listener = config.listeners[i]!;
  server.on("error", failed(listener));
  server.listen(listener.port, listener.host, () => {
    // `port 0` is assigned by the system: report the real one.
    const scheme = listener.https ? "https" : "http";
    console.log(`proxy listening on ${listener.host}:${(server.address() as AddressInfo).port} (${scheme})`);
  });
}

if (options.ui && config.logFile) {
  const ui = createUiServer(config.logFile);
  ui.on("error", (error: NodeJS.ErrnoException) => {
    console.error(`Error: no se pudo levantar la ui en 127.0.0.1:${options.uiPort}: ${error.code ?? error.message}`);
    process.exit(1);
  });
  // Loopback only: the log has request headers and bodies.
  ui.listen(options.uiPort, "127.0.0.1", () => {
    console.log(`ui listening on http://127.0.0.1:${(ui.address() as AddressInfo).port}`);
  });
}
