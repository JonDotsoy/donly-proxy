import { run, type RunResult } from "../run";
import type { CurlRequest, CurlResponse } from "../types";

/**
 * Fixed curl flags shared by the local and the remote (ssh) runs. The body comes out of
 * stdout, the status and headers out of stderr (`%{stderr}...`), so neither has to be
 * parsed out of the other.
 */
export const curlFlags = (method: string, hasBody: boolean) => [
  "--silent", "--compressed", "--proto", "=http,https",
  "--write-out", "%{stderr}%{response_code}\n%{header_json}",
  "--header", "Expect:",
  ...(method === "HEAD"
    ? ["--head", "--output", "/dev/null"]
    : ["--output", "-", ...(hasBody ? ["--data-binary", "@-"] : [])]),
];

/** Turns what curl wrote (stdout, stderr) into a response, or throws. */
export const parseCurlResult = ({ code, stdout, stderr }: RunResult, label = "curl"): CurlResponse => {
  const meta = stderr.toString();
  // ssh and other wrappers may add their own noise before the write-out.
  const match = /(\d{3})\n(\{[\s\S]*\})\s*$/.exec(meta);
  if (code !== 0 || !match) {
    throw new Error(`${label} exited with ${code}: ${meta.trim() || "no output"}`);
  }
  const raw = JSON.parse(match[2]!) as Record<string, string[]>;
  const headers: CurlResponse["headers"] = {};
  for (const [name, values] of Object.entries(raw)) {
    headers[name.toLowerCase()] = values.length === 1 ? values[0]! : values;
  }
  return { status: Number(match[1]), headers, body: stdout };
};

/** Hands a request over to the local `curl` binary and returns its response. */
export const curl = async ({ method, url, headers, body, args, onCommand }: CurlRequest) => {
  const argv = [...curlFlags(method, body.length > 0)];
  if (method !== "HEAD") argv.push("--request", method);
  for (const [name, value] of Object.entries(headers)) argv.push("--header", `${name}: ${value}`);
  argv.push(...args, "--url", url);
  return parseCurlResult(await run("curl", argv, body, onCommand));
};
