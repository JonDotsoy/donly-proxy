import type { CurlRequest, CurlResponse } from "./curl";
import { parseRemoteResult, remoteCommand, type Engine } from "./remote";
import { run } from "./run";

/**
 * Runs the request inside a Kubernetes pod with `kubectl exec`, using the chosen engine
 * (`curl` or `node`). `args` are kubectl options followed by the target (`[-n prod] deploy/api`).
 */
export const kubectlRequest = async (request: CurlRequest, engine: Engine): Promise<CurlResponse> => {
  const { command, input } = remoteCommand(request, engine);
  // The command is passed as plain arguments after `--` (no local shell); `sh -c` gives
  // the fixed command line a shell inside the container.
  const exec = engine === "node" ? command.split(" ") : ["sh", "-c", command];
  const argv = ["exec", "-i", "-q", ...request.args.slice(0, -1), request.args.at(-1)!, "--", ...exec];
  return parseRemoteResult(await run("kubectl", argv, input), engine, "kubectl");
};
