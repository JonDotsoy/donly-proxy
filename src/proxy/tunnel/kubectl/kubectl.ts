import type { CurlRequest, CurlResponse } from "../types";
import { parseRemoteResult, remoteCommand, type Engine } from "../remote";
import { run } from "../run";

/** Turns a `pod_match` glob (`*` and `?`) into an anchored regex. */
const globToRegExp = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

/** The first running pod (`kubectl get pods`, in the order kubectl lists them) whose name matches the glob. */
const resolvePod = async (glob: string, selectors: string[], lookup: CurlRequest["onLookup"], system: CurlRequest["system"]) => {
  const argv = ["get", "pods", ...selectors, "--field-selector=status.phase=Running", "-o", "name"];
  const { code, stdout, stderr } = await run("kubectl", argv, "", lookup?.onCommand, undefined, lookup?.onExit, lookup?.onConsole, system, lookup?.logger);
  if (code !== 0) throw new Error(`kubectl get pods exited with ${code}: ${stderr.toString().trim()}`);
  const regex = globToRegExp(glob);
  const pod = stdout.toString().split("\n").map((l) => l.trim().replace(/^pod\//, "")).find((name) => name !== "" && regex.test(name));
  if (pod === undefined) throw new Error(`no running pod matches pod_match ${glob}`);
  return `pod/${pod}`;
};

/**
 * Runs the request inside a Kubernetes pod with `kubectl exec`, using the chosen engine
 * (`curl` or `node`). `args` are kubectl options followed by the target (`[-n prod] deploy/api`).
 */
export const kubectlRequest = async (request: CurlRequest, engine: Engine): Promise<CurlResponse> => {
  const { command, input } = remoteCommand(request, engine);
  // The command is passed as plain arguments after `--` (no local shell); `sh -c` gives
  // the fixed command line a shell inside the container.
  const exec = engine === "node" ? command.split(" ") : ["sh", "-c", command];
  const target = request.podMatch ? await resolvePod(request.podMatch.glob, request.podMatch.selectors, request.onLookup, request.system) : request.args.at(-1)!;
  const options = request.podMatch ? request.args : request.args.slice(0, -1);
  const argv = ["exec", "-i", "-q", ...options, target, "--", ...exec];
  return parseRemoteResult(await run("kubectl", argv, input, request.onCommand, undefined, request.onExit, request.onConsole, request.system, request.logger), engine, "kubectl");
};
