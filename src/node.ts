import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CurlRequest, CurlResponse } from "./curl";

const script = fileURLToPath(new URL("./node-request.mjs", import.meta.url));

/**
 * Hands a request over to a `node` process that performs it with
 * `http.request` / `https.request` (see `node-request.mjs`).
 * `args` are extra node options, placed before the script.
 */
export const nodeRequest = ({ method, url, headers, body, args }: CurlRequest) =>
  new Promise<CurlResponse>((resolve, reject) => {
    const child = spawn("node", [...args, script], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ method, url, headers, body: body.toString("base64") }));
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`node exited with ${code}: ${Buffer.concat(err).toString().trim() || "no output"}`));
      }
      try {
        const result = JSON.parse(Buffer.concat(out).toString());
        resolve({ status: result.status, headers: result.headers, body: Buffer.from(result.body, "base64") });
      } catch {
        reject(new Error(`node returned an invalid response: ${Buffer.concat(err).toString().trim()}`));
      }
    });
  });
