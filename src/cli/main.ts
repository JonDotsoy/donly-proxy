import type { AddressInfo } from "node:net";
import { argument, flag, flags } from "@jondotsoy/flags";
import pkg from "../../package.json";
import { createProxyServer, loadConfig } from "../proxy/server";

const parser = flags({
  help: flag("--help", "-h").boolean().describe("Muestra esta ayuda"),
  version: flag("--version", "-V").boolean().describe("Muestra la versión"),
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

const config = await loadConfig(options.manifest);
const server = createProxyServer(config);
server.listen(config.port, config.host, () => {
  // `port 0` (the default) is assigned by the system: report the real one.
  console.log(`proxy listening on ${config.host}:${(server.address() as AddressInfo).port}`);
});
