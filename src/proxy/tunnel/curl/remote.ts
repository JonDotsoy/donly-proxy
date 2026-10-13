import { curlFlags } from "./curl";
import type { CurlRequest } from "../types";
import { quote } from "../quote";

/** Escapes a value for a double-quoted string in a curl config file (`curl -K`). */
const configString = (value: string) => {
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) throw new Error("control characters are not allowed in a request sent over ssh");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\t", "\\t")}"`;
};

export const curlRemote = (request: CurlRequest) => {
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
