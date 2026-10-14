import type { CurlRequest } from "../types";
import { nodeStdin } from "./node";

export const nodeRemote = (request: CurlRequest) => {
  const options = request.engineArgs ?? [];
  // The node command is passed as plain words (no shell), so options cannot hold spaces.
  if (options.some((option) => /\s/.test(option))) throw new Error("node options cannot contain whitespace");
  const input = nodeStdin(request);
  request.onScript?.(input);
  return { command: ["node", ...options, "--input-type=module", "-"].join(" "), input };
};
