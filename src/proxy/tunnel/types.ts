/** One piece of console traffic of a command: what was written to its stdin and what it printed. */
export interface ConsoleEntry {
  type: "stdout" | "stderr" | "stdin";
  /** ISO 8601 moment of the piece. */
  timestamp: string;
  message: string;
}

export interface CurlRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  /** Extra command options from the manifest (curl options, node options or ssh options). */
  args: string[];
  /** Extra options for the remote engine (`kubectl_pass … { command_pass curl <options> }`). */
  engineArgs?: string[];
  /** Password for `ssh` (`ssh_pass … { pass … }`): handed over through an askpass program, not `argv`. */
  password?: string;
  /** Called with the full command line (program and arguments) right before it runs. */
  onCommand?: (command: string[]) => void;
  /** Called with the script that the node engine sends to a remote `node` through stdin. */
  onScript?: (script: string) => void;
  /** Called with every stdin/stdout/stderr piece of the command, in order, as it happens. */
  onConsole?: (entry: ConsoleEntry) => void;
  /** Called with the exit code of that command once it has finished. */
  onExit?: (code: number | null) => void;
}

export interface CurlResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}
