import type { CurlRequest } from "./types";
import { parseCurlResult } from "./curl/curl";
import { curlRemote } from "./curl/remote";
import { parseNodeResult } from "./node/node";
import { nodeRemote } from "./node/remote";
import type { RunResult } from "./run";
import { parseWgetResult, wgetRemote } from "./wget/wget";

export type Engine = "curl" | "node" | "wget";

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
