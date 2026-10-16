/** One piece of console traffic of a command: what was written to its stdin and what it printed. */
export interface ConsoleEntry {
  type: "stdout" | "stderr" | "stdin";
  /** ISO 8601 moment of the piece. */
  timestamp: string;
  message: string;
}

import type { SystemSpawn } from "../../spawn";

export interface CurlRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  /** Extra command options from the manifest (curl options, node options or ssh options). */
  args: string[];
  /** Extra options for the remote engine (`kubectl_pass … { command_pass curl <options> }`). */
  engineArgs?: string[];
  /** `kubectl_pass … { pod_match <glob> }`: the pod is the first running one whose name matches; `selectors` are its `--context` / `--namespace`. */
  podMatch?: { glob: string; selectors: string[] };
  /** Callbacks for the `kubectl get pods` that `podMatch` runs first (same meaning as `onCommand`, `onConsole` and `onExit`). */
  onLookup?: Pick<CurlRequest, "onCommand" | "onConsole" | "onExit">;
  /** Password for `ssh` (`ssh_pass … { pass … }`): handed over through an askpass program, not `argv`. */
  password?: string;
  /** Called with the full command line (program and arguments) right before it runs. */
  onCommand?: (command: string[]) => void;
  /** Called with the script that the node engine sends to a remote `node` through stdin. */
  onScript?: (script: string) => void;
  /** Called with every stdin/stdout/stderr piece of the command, in order, as it happens. */
  onConsole?: (entry: ConsoleEntry) => void;
  /** Where the commands run (a shell already running, see `SystemSpawn.fromResponse`); by default as child processes. */
  system?: SystemSpawn;
  /** Called with the exit code of that command once it has finished. */
  onExit?: (code: number | null) => void;
}

export interface CurlResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}
