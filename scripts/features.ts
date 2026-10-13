#!/usr/bin/env bun
/**
 * Generates docs/system/features.md from the specs recorded by `testFeature`
 * (src/utils/test_utils/test-feature): every test declares the payload and the
 * features it exercises, and the run saves them, linted, in
 * `__test_features__/spec_tests.json`.
 *
 *   bun scripts/features.ts            # runs `bun test` and rewrites the document
 *   bun scripts/features.ts --check    # same, but fails if the document is out of date
 *   bun scripts/features.ts --no-run   # reuse the existing spec_tests.json instead of running the tests
 *
 * The run fails when a spec did not pass (failed, or pending because the test timed out).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const specFile = join(root, "src/utils/test_utils/test-feature/__test_features__/spec_tests.json");
const file = join(root, "docs/system/features.md");

const args = process.argv.slice(2);
const check = args.includes("--check");

interface Spec {
  id: string;
  description: string;
  lint: string;
  status: "pending" | "passed" | "failed" | "skipped";
}

if (!args.includes("--no-run")) {
  const run = spawnSync("bun", ["test"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  if (run.error) throw run.error;
}

const specs: Spec[] = JSON.parse(readFileSync(specFile, "utf8"));
if (specs.length === 0) {
  console.error("features: no specs found in spec_tests.json");
  process.exit(1);
}

// Ports of the servers started by the tests change on every run.
const stable = (lint: string) => lint.replaceAll(/\b(127\.0\.0\.1|localhost):\d+/g, "$1:<port>");
const icon = { passed: "✅", failed: "🔴", pending: "⏳", skipped: "⏭️" } as const;
const count = (status: Spec["status"]) => specs.filter((s) => s.status === status).length;

const sorted = [...specs].sort((a, b) => a.description.localeCompare(b.description) || stable(a.lint).localeCompare(stable(b.lint)));
const fence = "```";
const document = `# Features

Generado por \`bun run features\` a partir de \`spec_tests.json\` (las specs que registra
\`testFeature\`, ver \`src/utils/test_utils/test-feature\`). No lo edites a mano.

Cada spec es un test: las líneas marcadas con \`+\` son las directivas del manifest que el test
ejercita (\`-\` si el test falla).

Specs: **${specs.length}** · ✅ pasan: **${count("passed")}** · 🔴 fallan: **${count("failed")}** · ⏳ sin resultado: **${count("pending")}** · ⏭️ omitidas: **${count("skipped")}**

${sorted.map((s) => `## ${s.description}\n\n**Status:** ${icon[s.status]} ${s.status}\n\n${fence}diff\n${stable(s.lint)}${fence}\n`).join("\n")}`;

const problems = specs
  .filter((s) => s.status === "failed" || s.status === "pending")
  .map((s) => `${s.status} spec: "${s.description}"`);

const original = (() => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
})();
if (check) {
  if (document !== original) problems.push("docs/system/features.md is out of date: run `bun run features`");
} else if (document !== original) {
  writeFileSync(file, document);
  console.log("features: updated docs/system/features.md");
} else {
  console.log("features: docs/system/features.md is up to date");
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`features: ${problem}`);
  process.exit(1);
}
