import { afterAll, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listFeatures } from "../lint-features/list-features";

const outDir = join(import.meta.dir, "__test_features__");
const specFile = join(outDir, "spec_tests.json");
const reportFile = join(outDir, "features.md");

export interface SpecTest {
  id: string;
  description: string;
  /** The payload with the lines of the tested features marked (see `listFeatures`). */
  lint: string;
  status: "pending" | "passed" | "failed" | "skipped";
  /** Stack of the error of a failed test. */
  error?: string;
}

const readSpecs = (): SpecTest[] => {
  try {
    return JSON.parse(readFileSync(specFile, "utf8"));
  } catch {
    return [];
  }
};

/** Records the spec of a feature test into `__test_features__/spec_tests.json` (git-ignored). */
const record = (spec: SpecTest) => {
  mkdirSync(outDir, { recursive: true });
  const ignore = join(outDir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  const specs = readSpecs().filter((s) => s.id !== spec.id);
  writeFileSync(specFile, `${JSON.stringify([...specs, spec], null, 2)}\n`);
};

// Bun loads this module once per run: start every run from an empty spec list.
mkdirSync(outDir, { recursive: true });
writeFileSync(specFile, "[]\n");
const calls = new Map<string, number>();

/** Writes `__test_features__/features.md` from the recorded specs. */
const writeReport = () => {
  const fence = "```";
  const sections = readSpecs().map(
    ({ description, status, lint, error }) =>
      `## ${description}\n\n**Status:** ${status}\n\n${fence}diff\n${lint}${fence}\n` +
      (error ? `\n${fence}\n${error}\n${fence}\n` : ""),
  );
  writeFileSync(reportFile, `${sections.join("\n")}`);
};

type Run = (payload: string) => void | Promise<void>;
type Register = (name: string, fn: () => Promise<void>, timeout?: number) => void;

const declare = (
  register: Register,
  skipped: boolean,
  donlyPayload: string,
  features: string[],
  description: string,
  run?: Run,
  timeout?: number,
) => {
  const { features: lint } = listFeatures(donlyPayload, features, description);
  const hash = createHash("sha1")
    .update(JSON.stringify([description, donlyPayload, features]))
    .digest("hex")
    .slice(0, 12);
  // The same spec declared twice in a run gets its own entry.
  const occurrence = calls.get(hash) ?? 0;
  calls.set(hash, occurrence + 1);
  const id = occurrence === 0 ? hash : `${hash}-${occurrence}`;
  const spec: SpecTest = { id, description, lint, status: skipped ? "skipped" : "pending" };
  record(spec);
  // Bun shares this module between test files, so each file registers its own hook.
  afterAll(writeReport);
  if (run) {
    register(
      description,
      async () => {
        try {
          await run(donlyPayload);
          record({ ...spec, status: "passed" });
        } catch (error) {
          const failed = listFeatures(donlyPayload, features, description, "- ").features;
          record({ ...spec, lint: failed, status: "failed", error: error instanceof Error ? (error.stack ?? String(error)) : String(error) });
          throw error;
        }
      },
      timeout,
    );
  }
  return id;
};

/**
 * Declares a test of the `features` (donly paths) of a payload. Generates an
 * id for the spec (a hash of description, payload and features, plus a counter when
 * the same spec is declared more than once) and saves it with the description and
 * the linted payload in `spec_tests.json`. When `run` is given, it is registered as
 * the test (named `description`) and receives the payload; a failure marks the
 * lines of the features with `- ` in the report.
 */
export const testFeature = (
  donlyPayload: string,
  features: string[],
  description: string,
  run?: Run,
  timeout?: number,
) => declare(test, false, donlyPayload, features, description, run, timeout);

/** Like `testFeature`, but the test is skipped. */
testFeature.skip = (
  donlyPayload: string,
  features: string[],
  description: string,
  run?: Run,
  timeout?: number,
) => declare(test.skip, true, donlyPayload, features, description, run, timeout);
