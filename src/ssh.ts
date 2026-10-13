import { curlFlags, parseCurlResult, type CurlRequest, type CurlResponse } from "./curl";
import { nodeInput, parseNodeResult, scriptSource } from "./node";
import { run } from "./run";

export type Engine = "curl" | "node";

// Everything that reaches the remote shell is either fixed text or base64 / quoted
// literals built here: request data (URL, headers, body) never gets interpreted by a shell.
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Escapes a value for a double-quoted string in a curl config file (`curl -K`). */
const configString = (value: string) => {
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) throw new Error("control characters are not allowed in a request sent over ssh");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\t", "\\t")}"`;
};

const curlRemote = (request: CurlRequest) => {
  const config = [
    `url = ${configString(request.url)}`,
    ...(request.method === "HEAD" ? [] : [`request = ${configString(request.method)}`]),
    ...Object.entries(request.headers).map(([name, value]) => `header = ${configString(`${name}: ${value}`)}`),
  ].join("\n");
  const flags = curlFlags(request.method, request.body.length > 0).map(quote).join(" ");
  const command =
    `d=$(mktemp -d) && trap 'rm -rf "$d"' EXIT && ` +
    `printf %s ${quote(Buffer.from(config).toString("base64"))} | base64 -d > "$d/c" && ` +
    `curl -K "$d/c" ${flags}`;
  return { command, input: request.body };
};

const nodeRemote = (request: CurlRequest) => {
  const prelude = `globalThis.__donlyRequest = JSON.parse(Buffer.from(${JSON.stringify(
    Buffer.from(JSON.stringify(nodeInput(request))).toString("base64"),
  )}, "base64").toString());\n`;
  return { command: "node --input-type=module -", input: prelude + scriptSource() };
};

/**
 * Runs the request on a remote host over `ssh` with the chosen engine (`curl` or `node`).
 * `args` are ssh options followed by the destination (`[-p 2222] user@host`).
 */
export const sshRequest = async (request: CurlRequest, engine: Engine): Promise<CurlResponse> => {
  const { command, input } = engine === "node" ? nodeRemote(request) : curlRemote(request);
  const argv = [...request.args.slice(0, -1), "-T", "-q", "-o", "BatchMode=yes", request.args.at(-1)!, command];
  const result = await run("ssh", argv, input);
  return engine === "node" ? parseNodeResult(result, "ssh node") : parseCurlResult(result, "ssh curl");
};
