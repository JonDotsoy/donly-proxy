import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { argument, flag, flags } from "@jondotsoy/flags";
import pkg from "../../package.json";
import { lintManifestFile } from "../proxy/lint";
import { runManifest } from "../proxy/hot-reload";
import { loadConfigs } from "../proxy/server";
import { createUiServer } from "../ui/server";

const parser = flags({
  help: flag("--help", "-h").boolean().describe("Muestra esta ayuda"),
  version: flag("--version", "-V").boolean().describe("Muestra la versión"),
  ui: flag("--ui").boolean().describe("Levanta una página con los logs en vivo (requiere log_file)"),
  uiPort: flag("--ui-port").number().default(8081).describe("Puerto de la página de logs (por defecto 8081)"),
  noReload: flag("--no-reload", "--no-hot").boolean().describe("Desactiva la recarga en caliente: los cambios del manifiesto no se aplican hasta reiniciar"),
  manifest: argument().string().describe("Ruta al manifiesto .donly (por defecto, el primero que exista en el directorio actual: proxy.donly, .proxy.donly, manifest.donly, .manifest.donly)"),
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

// Without arguments, use the first of these that exists in the current directory.
const defaultManifests = ["proxy.donly", ".proxy.donly", "manifest.donly", ".manifest.donly"];
const manifest = options.manifest ?? defaultManifests.find((name) => existsSync(name));
if (!manifest || !existsSync(manifest)) {
  console.error(
    options.manifest
      ? `Error: no se encontró el manifiesto ${options.manifest} (buscado en ${resolve(options.manifest)})`
      : `Error: no se encontró ningún manifiesto por defecto (${defaultManifests.join(", ")}) en ${resolve(".")}; indica uno como argumento`,
  );
  process.exit(1);
}

console.error(`leyendo manifiesto ${resolve(manifest)}${options.manifest ? "" : " (por defecto)"}`);

// Lint errors abort the start; warnings are printed and let it continue.
if (!(await lintManifestFile(manifest))) {
  process.exit(1);
}

const configs = await loadConfigs(manifest);
const logFile = configs.find((c) => c.logFile)?.logFile;
if (options.ui && !logFile) {
  console.error("Error: --ui requiere log_file en el manifiesto para poder mostrar los logs");
  process.exit(1);
}
try {
  await runManifest(manifest, { reload: !options.noReload });
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  process.exit(1);
}

if (options.ui && logFile) {
  const ui = createUiServer(logFile);
  ui.on("error", (error: NodeJS.ErrnoException) => {
    console.error(`Error: no se pudo levantar la ui en 127.0.0.1:${options.uiPort}: ${error.code ?? error.message}`);
    process.exit(1);
  });
  // Loopback only: the log has request headers and bodies.
  ui.listen(options.uiPort, "127.0.0.1", () => {
    console.log(`ui listening on http://127.0.0.1:${(ui.address() as AddressInfo).port}`);
  });
}
