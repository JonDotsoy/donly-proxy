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
}

export interface CurlResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}
