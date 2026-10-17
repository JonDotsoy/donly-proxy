import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

export type FakeProgram = "kubectl" | "ssh";

/** One queued answer: what the next call prints and how it ends. Without `stdout` or `exit` the call runs normally. */
export interface FakeAnswer {
  stdout?: string;
  stderr?: string;
  exit?: number;
}

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
 * For "the next stdout must be X", `next()` queues an answer in a file the binary reads and consumes
 * (one queued answer per call, in order, then the default behavior resumes). The queue is shared
 * state on disk between the test (this process) and the fake binary (a child of the proxy).
 *
 * `kubectl --version` answers like the real one; `kubectl exec` without `--` fails instead of looping.
 */
const script = (program: FakeProgram, calls: string) => `#!/bin/sh
mkdir -p "${calls}"
sub=exec
${program === "kubectl" ? '[ "$1" = "get" ] && sub=get' : ""}
printf '%s\\0' "$@" > "${calls}/${program}.$sub.args"
echo x >> "${calls}/${program}.$sub.count"
${program === "kubectl" ? 'case "$1" in\n  --version|version) echo "Client Version: v0.0.0-fake"; exit 0 ;;\nesac' : ""}
taken=""
for d in "${calls}/queue/${program}.$sub"/*; do
  [ -d "$d" ] || continue
  mkdir -p "${calls}/taken"
  if mv "$d" "${calls}/taken/$$" 2>/dev/null; then taken="${calls}/taken/$$"; break; fi
done
if [ -n "$taken" ]; then
  [ -f "$taken/stderr" ] && cat "$taken/stderr" >&2
  [ -f "$taken/stdout" ] && { cat > /dev/null; cat "$taken/stdout"; }
  [ -f "$taken/exit" ] && exit "$(cat "$taken/exit")"
  [ -f "$taken/stdout" ] && exit 0
fi
${
  program === "kubectl"
    ? `if [ "$sub" = "get" ]; then
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
  let seq = 0;
  const queueDir = (program: FakeProgram, sub: string) => join(calls, "queue", `${program}.${sub}`);
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
    /**
     * Queues the answer of the next call that has no answer queued before it (`sub` as in `args`).
     * Answers are consumed in the order they were queued, one per call.
     */
    next(program: FakeProgram, answer: FakeAnswer, sub: "exec" | "get" = "exec") {
      const entry = join(queueDir(program, sub), String(seq++).padStart(6, "0"));
      mkdirSync(entry, { recursive: true });
      if (answer.stdout !== undefined) writeFileSync(join(entry, "stdout"), answer.stdout);
      if (answer.stderr !== undefined) writeFileSync(join(entry, "stderr"), answer.stderr);
      if (answer.exit !== undefined) writeFileSync(join(entry, "exit"), String(answer.exit));
    },
    /** How many queued answers no call has consumed yet. */
    pending(program: FakeProgram, sub: "exec" | "get" = "exec") {
      const dir = queueDir(program, sub);
      return existsSync(dir) ? readdirSync(dir).length : 0;
    },
    /** Forgets the recorded calls and the queued answers. */
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
