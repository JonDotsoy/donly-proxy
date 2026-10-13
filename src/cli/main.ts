import { createProxyServer, loadConfig } from "../proxy/server";

const config = await loadConfig(process.argv[2]);
createProxyServer(config).listen(config.port, config.host, () => {
  console.log(`proxy listening on ${config.host}:${config.port}`);
});

