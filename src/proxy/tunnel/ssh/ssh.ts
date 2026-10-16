import type { CurlRequest, CurlResponse } from "../types";
import { parseRemoteResult, remoteCommand, type Engine } from "../remote";
import { run } from "../run";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let askpassProgram: string | undefined;

/**
 * A tiny program for `SSH_ASKPASS` that prints `$DONLY_SSH_PASSWORD`, so the password travels in
 * the environment of the ssh process instead of its command line. Only the owner can use it.
 */
const askpass = () => {
  if (!askpassProgram) {
    const dir = mkdtempSync(join(tmpdir(), "donly-proxy-askpass-"));
    askpassProgram = join(dir, "askpass.sh");
    writeFileSync(askpassProgram, `#!/bin/sh\nprintf '%s\\n' "$DONLY_SSH_PASSWORD"\n`);
    chmodSync(askpassProgram, 0o700);
  }
  return askpassProgram;
};

/**
 * Runs the request on a remote host over `ssh` with the chosen engine (`curl` or `node`).
 * `args` are ssh options followed by the destination (`[-p 2222] user@host`).
 */
export const sshRequest = async (request: CurlRequest, engine: Engine): Promise<CurlResponse> => {
  const { command, input } = remoteCommand(request, engine);
  // BatchMode forbids any prompt, including the askpass one: with a password it has to go.
  const auth = request.password === undefined ? ["-o", "BatchMode=yes"] : ["-o", "NumberOfPasswordPrompts=1"];
  const env =
    request.password === undefined
      ? undefined
      : { SSH_ASKPASS: askpass(), SSH_ASKPASS_REQUIRE: "force", DONLY_SSH_PASSWORD: request.password };
  const argv = [...request.args.slice(0, -1), "-T", "-q", ...auth, request.args.at(-1)!, command];
  return parseRemoteResult(await run("ssh", argv, input, request.onCommand, env, request.onExit, request.onConsole, request.system, request.logger), engine, "ssh");
};
