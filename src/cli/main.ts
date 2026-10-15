import type { AddressInfo } from "node:net";
import { lintManifestFile } from "../proxy/lint";
import { createProxyServer, loadConfig } from "../proxy/server";

// Lint errors abort the start; warnings are printed and let it continue.
if (!(await lintManifestFile(process.argv[2] ?? new URL("../../manifest.donly", import.meta.url)))) {
  process.exit(1);
}

const config = await loadConfig(process.argv[2]);
const server = createProxyServer(config);
server.listen(config.port, config.host, () => {
  // `port 0` (the default) is assigned by the system: report the real one.
  console.log(`proxy listening on ${config.host}:${(server.address() as AddressInfo).port}`);
});
