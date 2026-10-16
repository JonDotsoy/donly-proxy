import { spawnChildProcess } from "./child-process";
import { nestedSpawner } from "./nested";
import { spawnLogged, type SpawnLogger } from "./logged";
import type { ShellRequest, ShellResponse } from "./shell";

export interface SpawnOptions {
  /** Where the request runs. Defaults to `SystemSpawn.defaultChildProcess`. */
  system?: SystemSpawn;
  /** Writes the request to the `.ndjson` log: `command_start` before it runs and `command_end` with its exit code and console output. */
  logger?: SpawnLogger;
}

/** An API that runs processes: as children of this process, or inside another running process. */
export class SystemSpawn {
  /** Runs processes as child processes of this one. */
  static readonly defaultChildProcess = new SystemSpawn(spawnChildProcess);

  /** Runs processes inside the shell started by `response`, which must read its commands from stdin (e.g. `bash`). */
  static fromResponse(response: ShellResponse): SystemSpawn {
    return new SystemSpawn(nestedSpawner(response));
  }

  private constructor(private readonly run: (request: ShellRequest) => Promise<ShellResponse>) {}

  spawn(request: ShellRequest, options?: Omit<SpawnOptions, "system">): Promise<ShellResponse> {
    return options?.logger ? spawnLogged(options.logger, request, this.run) : this.run(request);
  }
}

export const spawn = (request: ShellRequest, options?: SpawnOptions): Promise<ShellResponse> =>
  (options?.system ?? SystemSpawn.defaultChildProcess).spawn(request, options);
