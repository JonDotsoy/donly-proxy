import type { CurlRequest, CurlResponse } from "./curl";
import type { RunResult } from "./run";

// Everything that reaches the remote shell is either fixed text or a quoted literal.
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const checked = (value: string) => {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("control characters are not allowed in a request sent with wget");
  return value;
};

/**
 * The remote command line for `wget` and its stdin. wget (BusyBox included) can only do GET
 * and POST: a body means POST, and any other method is refused. The body goes through a
 * temporary file because `--post-file` needs a regular file.
 */
export const wgetRemote = ({ method, url, headers, body, engineArgs = [] }: CurlRequest) => {
  const post = body.length > 0 || method === "POST";
  if (method !== (post ? "POST" : "GET")) {
    throw new Error(`wget only supports GET and POST (a body means POST), not ${method}${body.length > 0 ? " with a body" : ""}`);
  }
  const options = [
    "-q", "-S", "-O", "-",
    ...Object.entries(headers).flatMap(([name, value]) => ["--header", checked(`${name}: ${value}`)]),
    ...engineArgs,
  ].map((option) => quote(checked(option))).join(" ");
  const command =
    `d=$(mktemp -d) && trap 'rm -rf "$d"' EXIT && cat > "$d/b" && ` +
    `wget ${options}${post ? ' --post-file "$d/b"' : ""} ${quote(checked(url))}`;
  return { command, input: body };
};

/**
 * Turns what wget wrote into a response, or throws. `-S` prints the status line and the
 * headers of every response (redirects included) on stderr, indented by two spaces; the
 * last block is the final response. A 4xx / 5xx makes wget exit non-zero without a body,
 * but its status is still known.
 */
export const parseWgetResult = ({ code, stdout, stderr }: RunResult, label = "wget"): CurlResponse => {
  const meta = stderr.toString();
  const lines = meta.split("\n").map((line) => line.replace(/\r$/, ""));
  const start = lines.findLastIndex((line) => /^ {2}HTTP\/\d(?:\.\d)? \d{3}/.test(line));
  if (start === -1 || (code !== 0 && code !== 1 && code !== 8)) {
    throw new Error(`${label} exited with ${code}: ${meta.trim() || "no output"}`);
  }
  const headers: CurlResponse["headers"] = {};
  for (const line of lines.slice(start + 1)) {
    const match = /^ {2}([^:\s]+):\s*(.*)$/.exec(line);
    if (!match) break;
    const name = match[1]!.toLowerCase();
    const previous = headers[name];
    headers[name] = previous === undefined ? match[2]! : [previous, match[2]!].flat();
  }
  return { status: Number(/ (\d{3})/.exec(lines[start]!)![1]), headers, body: stdout };
};
