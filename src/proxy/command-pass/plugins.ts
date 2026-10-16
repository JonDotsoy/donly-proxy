import type { CommandPass } from "./command-pass";
import { tunnelPlugin } from "./command-pass";
import { installProxy } from "./proxy";
import { curl } from "../tunnel/curl/curl";
import { kubectlRequest } from "../tunnel/kubectl/kubectl";
import { nodeRequest } from "../tunnel/node/node";
import { sshRequest } from "../tunnel/ssh/ssh";

const installCurl = tunnelPlugin((request) => curl(request));
const installNode = tunnelPlugin((request) => nodeRequest(request));
const installSsh = tunnelPlugin((request, options) => sshRequest(request, options.engine ?? "curl"));
const installKubectl = tunnelPlugin((request, options) => kubectlRequest(request, options.engine ?? "curl"));

/** Every installed plugin. A route builds its own instance with the factory, so each keeps its own state. */
export const plugins: Record<string, () => CommandPass> = {
  curl: installCurl,
  node: installNode,
  ssh: installSsh,
  kubectl: installKubectl,
  proxy: installProxy,
};

/** Directives that are another spelling of a plugin. */
export const aliases: Record<string, string> = {
  proxy_pass: "proxy",
  ssh_pass: "ssh",
  kubectl_pass: "kubectl",
};

export const createPlugin = (name: string) => {
  const factory = plugins[aliases[name] ?? name];
  if (!factory) throw new Error(`command_pass: no hay un plugin llamado "${name}"`);
  return factory();
};
