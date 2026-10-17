import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

export type FakeProgram = "kubectl" | "ssh";

/**
 * Dummy `kubectl` and `ssh` binaries for tests. They never touch a cluster or a network: what the
 * real program would run remotely (`kubectl exec … -- cmd`, `ssh … cmd`) runs locally instead.
 * Each call is recorded, and the environment of the proxy scripts the answer:
 *
 * - `FAKE_CLI_EXIT` / `FAKE_CLI_STDERR`: fail the call with that code and message (any program).
 * - `FAKE_CLI_STDOUT`: print this instead of running the remote command (any program).
 * - `FAKE_KUBECTL_PODS`: what `kubectl get pods -o name` lists (default: three pods).
 * - `FAKE_KUBECTL_GET_EXIT`: make only `kubectl get` fail.
 *
 * `kubectl --version` answers like the real one; `kubectl exec` without `--` fails instead of looping.
 */
const script = (program: FakeProgram, calls: string) => `#!/bin/sh
mkdir -p "${calls}"
sub=exec
${program === "kubectl" ? '[ "$1" = "get" ] && sub=get' : ""}
printf '%s\\0' "$@" > "${calls}/${program}.$sub.args"
echo x >> "${calls}/${program}.$sub.count"
${
  program === "kubectl"
    ? `case "$1" in
  --version|version) echo "Client Version: v0.0.0-fake"; exit 0 ;;
esac
if [ "$sub" = "get" ]; then
  [ -n "$FAKE_KUBECTL_GET_EXIT" ] && { echo "boom" >&2; exit "$FAKE_KUBECTL_GET_EXIT"; }
  if [ -n "$FAKE_KUBECTL_PODS" ]; then printf '%b\\n' "$FAKE_KUBECTL_PODS"; else printf 'pod/other-1\\npod/my-pod-12345\\npod/my-pod-99\\n'; fi
  exit 0
fi`
    : ""
}
if [ -n "$FAKE_CLI_EXIT" ]; then
  [ -n "$FAKE_CLI_STDERR" ] && printf '%s\\n' "$FAKE_CLI_STDERR" >&2
  exit "$FAKE_CLI_EXIT"
fi
if [ -n "$FAKE_CLI_STDOUT" ]; then
  cat > /dev/null
  printf '%s' "$FAKE_CLI_STDOUT"
  exit 0
fi
${
  program === "kubectl"
    ? 'while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ $# -eq 0 ] && { echo "error: kubectl exec needs a command after --" >&2; exit 1; }\nshift\nexec "$@"'
    : 'for last; do :; done\nexec sh -c "$last"'
}
`;

/** Writes the fake binaries under `dir` and returns the handles tests need. */
export const createFakeCli = (dir: string) => {
  const bin = join(dir, "fake-bin");
  const calls = join(dir, "fake-calls");
  mkdirSync(bin, { recursive: true });
  mkdirSync(calls, { recursive: true });
  for (const program of ["kubectl", "ssh"] as const) {
    writeFileSync(join(bin, program), script(program, calls));
    chmodSync(join(bin, program), 0o755);
  }
  const saved = { PATH: process.env.PATH, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  return {
    /** Puts the fakes first in `PATH` and empties `NO_PROXY`, so `fetch` goes through the proxy. */
    install() {
      process.env.PATH = `${bin}${delimiter}${saved.PATH}`;
      process.env.NO_PROXY = process.env.no_proxy = "";
    },
    /** Restores the environment `install` changed. */
    uninstall() {
      process.env.PATH = saved.PATH;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
    /** Arguments of the last call (`sub` is `exec`, or `get` for `kubectl get`). */
    args(program: FakeProgram, sub: "exec" | "get" = "exec") {
      const file = join(calls, `${program}.${sub}.args`);
      return existsSync(file) ? readFileSync(file, "utf8").split("\0").slice(0, -1) : [];
    },
    /** How many times the program was called since the last `reset`. */
    count(program: FakeProgram, sub: "exec" | "get" = "exec") {
      const file = join(calls, `${program}.${sub}.count`);
      return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
    },
    /** Forgets the recorded calls. */
    reset() {
      rmSync(calls, { recursive: true, force: true });
      mkdirSync(calls, { recursive: true });
    },
  };
};

/** Runs `fn` with the given variables set in this process (which the proxy and its children share). */
export const withEnv = async <T>(vars: Record<string, string>, fn: () => Promise<T>) => {
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};
