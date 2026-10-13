import type { CurlRequest } from "../types";
import { nodeInput, scriptSource } from "./node";

export const nodeRemote = (request: CurlRequest) => {
  const prelude = `globalThis.__donlyRequest = JSON.parse(Buffer.from(${JSON.stringify(
    Buffer.from(JSON.stringify(nodeInput(request))).toString("base64"),
  )}, "base64").toString());\n`;
  const options = request.engineArgs ?? [];
  // The node command is passed as plain words (no shell), so options cannot hold spaces.
  if (options.some((option) => /\s/.test(option))) throw new Error("node options cannot contain whitespace");
  const input = prelude + scriptSource();
  request.onScript?.(input);
  return { command: ["node", ...options, "--input-type=module", "-"].join(" "), input };
};
