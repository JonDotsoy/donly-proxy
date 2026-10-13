import { spawn } from "node:child_process";

export interface CurlRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  /** Extra curl options from the manifest, e.g. `--insecure`. */
  args: string[];
}

export interface CurlResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

/**
 * Hands a request over to the `curl` binary and returns its response.
 * The body goes through stdout, the status and headers through stderr
 * (`-w '%{stderr}...'`), so neither has to be parsed out of the other.
 */
export const curl = ({ method, url, headers, body, args }: CurlRequest) =>
  new Promise<CurlResponse>((resolve, reject) => {
    const argv = [
      "--silent", "--compressed", "--proto", "=http,https",
      "--write-out", "%{stderr}%{response_code}\n%{header_json}",
      "--header", "Expect:",
    ];
    if (method === "HEAD") argv.push("--head", "--output", "/dev/null");
    else {
      argv.push("--request", method, "--output", "-");
      if (body.length > 0) argv.push("--data-binary", "@-");
    }
    for (const [name, value] of Object.entries(headers)) argv.push("--header", `${name}: ${value}`);
    argv.push(...args, "--url", url);

    const child = spawn("curl", argv, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.stdin.end(body);
    child.on("close", (code) => {
      const meta = Buffer.concat(err).toString();
      const separator = meta.indexOf("\n");
      const status = Number(meta.slice(0, separator));
      if (code !== 0 || !status) {
        return reject(new Error(`curl exited with ${code}: ${meta.trim() || "no output"}`));
      }
      const raw = JSON.parse(meta.slice(separator + 1)) as Record<string, string[]>;
      const responseHeaders: CurlResponse["headers"] = {};
      for (const [name, values] of Object.entries(raw)) {
        responseHeaders[name.toLowerCase()] = values.length === 1 ? values[0]! : values;
      }
      resolve({ status, headers: responseHeaders, body: Buffer.concat(out) });
    });
  });
