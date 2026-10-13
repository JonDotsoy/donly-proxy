import { curlFlags, parseCurlResult, type CurlRequest } from "./curl";
import { nodeInput, parseNodeResult, scriptSource } from "./node";
import type { RunResult } from "./run";
import { parseWgetResult, wgetRemote } from "./wget";

export type Engine = "curl" | "node" | "wget";

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
  const flags = [...curlFlags(request.method, request.body.length > 0), ...(request.engineArgs ?? [])].map(quote).join(" ");
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
  const options = request.engineArgs ?? [];
  // The node command is passed as plain words (no shell), so options cannot hold spaces.
  if (options.some((option) => /\s/.test(option))) throw new Error("node options cannot contain whitespace");
  return { command: ["node", ...options, "--input-type=module", "-"].join(" "), input: prelude + scriptSource() };
};

/** What to run on the remote side: a shell command line (fixed text) plus its stdin. */
export const remoteCommand = (request: CurlRequest, engine: Engine) =>
  engine === "node" ? nodeRemote(request) : engine === "wget" ? wgetRemote(request) : curlRemote(request);

/** Interprets the output of the remote command for the chosen engine. */
export const parseRemoteResult = (result: RunResult, engine: Engine, label: string) =>
  engine === "node"
    ? parseNodeResult(result, `${label} node`)
    : engine === "wget"
      ? parseWgetResult(result, `${label} wget`)
      : parseCurlResult(result, `${label} curl`);
