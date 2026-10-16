import source from "./node-request.mjs" with { type: "text" };
import type { CurlRequest, CurlResponse } from "../types";
import { run, type RunResult } from "../run";

// Embedded as text so the bundle does not depend on the file existing next to it at runtime.
export const scriptSource = () => source;

/** The request in the JSON shape `node-request.mjs` expects. */
export const nodeInput = ({ method, url, headers, body }: CurlRequest) => ({
  method,
  url,
  headers,
  body: body.toString("base64"),
});

/** The script a `node` process reads from stdin: the request prelude followed by the code that performs it. */
export const nodeStdin = (request: CurlRequest) =>
  `globalThis.__donlyRequest = JSON.parse(Buffer.from(${JSON.stringify(
    Buffer.from(JSON.stringify(nodeInput(request))).toString("base64"),
  )}, "base64").toString());\n${scriptSource()}`;

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
export const nodeRequest = async (request: CurlRequest) => {
  const stdin = nodeStdin(request);
  request.onScript?.(stdin);
  return parseNodeResult(
    await run(
      "node",
      [...request.args, "--input-type=module", "-"],
      stdin,
      request.onCommand,
      undefined,
      request.onExit,
      request.onConsole,
      request.system,
      request.logger,
    ),
  );
};
