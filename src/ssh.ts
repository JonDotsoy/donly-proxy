import type { CurlRequest, CurlResponse } from "./curl";
import { parseRemoteResult, remoteCommand, type Engine } from "./remote";
import { run } from "./run";

/**
 * Runs the request on a remote host over `ssh` with the chosen engine (`curl` or `node`).
 * `args` are ssh options followed by the destination (`[-p 2222] user@host`).
 */
export const sshRequest = async (request: CurlRequest, engine: Engine): Promise<CurlResponse> => {
  const { command, input } = remoteCommand(request, engine);
  const argv = [...request.args.slice(0, -1), "-T", "-q", "-o", "BatchMode=yes", request.args.at(-1)!, command];
  return parseRemoteResult(await run("ssh", argv, input, request.onCommand), engine, "ssh");
};
