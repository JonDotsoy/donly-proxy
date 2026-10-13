import type { AddressInfo } from "node:net";
import { createProxyServer, loadConfig } from "../proxy/server";

const config = await loadConfig(process.argv[2]);
const server = createProxyServer(config);
server.listen(config.port, config.host, () => {
  // `port 0` (the default) is assigned by the system: report the real one.
  console.log(`proxy listening on ${config.host}:${(server.address() as AddressInfo).port}`);
});

