import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CurlRequest, CurlResponse } from "./curl";
import { run, type RunResult } from "./run";

const script = fileURLToPath(new URL("./node-request.mjs", import.meta.url));

export const scriptSource = () => readFileSync(script, "utf8");

/** The request in the JSON shape `node-request.mjs` expects. */
export const nodeInput = ({ method, url, headers, body }: CurlRequest) => ({
  method,
  url,
  headers,
  body: body.toString("base64"),
});

/** Turns what `node-request.mjs` wrote into a response, or throws. */
export const parseNodeResult = ({ code, stdout, stderr }: RunResult, label = "node"): CurlResponse => {
  if (code !== 0) {
    throw new Error(`${label} exited with ${code}: ${stderr.toString().trim() || "no output"}`);
  }
  try {
    const result = JSON.parse(stdout.toString());
    return { status: result.status, headers: result.headers, body: Buffer.from(result.body, "base64") };
  } catch {
    throw new Error(`${label} returned an invalid response: ${stderr.toString().trim()}`);
  }
};

/**
 * Hands a request over to a `node` process that performs it with
 * `http.request` / `https.request` (see `node-request.mjs`).
 * `args` are extra node options, placed before the script.
 */
export const nodeRequest = async (request: CurlRequest) =>
  parseNodeResult(
    await run("node", [...request.args, script], JSON.stringify(nodeInput(request)), request.onCommand),
  );
