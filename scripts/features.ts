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

// Ports of the servers and the random suffix of the temporary directories change on every run.
const stable = (lint: string) =>
  lint.replaceAll(/\b(127\.0\.0\.1|localhost):\d+/g, "$1:<port>").replaceAll(/(\/tmp\/donly-proxy-[\w-]*?-)[A-Za-z0-9]{6}\b/g, "$1<random>");
// A skipped test depends on the machine (kind cluster, IPv6): it counts as passed so the document is the same everywhere.
const statusOf = (spec: Spec) => (spec.status === "skipped" ? "passed" : spec.status);
const icon = { passed: "✅", failed: "🔴", pending: "⏳" } as const;
const count = (status: keyof typeof icon) => specs.filter((s) => statusOf(s) === status).length;

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "&#124;");
// Only the marked lines (`+ ` / `- `) go in the table, dedented; indentation is kept with &nbsp;.
const directives = (lint: string) => {
  const lines = lint
    .split("\n")
    .filter((line) => line.startsWith("+ ") || line.startsWith("- "))
    .map((line) => line.slice(2));
  const base = Math.min(...lines.map((line) => line.length - line.trimStart().length));
  return lines
    .map((line) => {
      const indent = line.length - line.trimStart().length - base;
      return `<code>${"&nbsp;".repeat(indent)}${escapeHtml(line.trimStart())}</code>`;
    })
    .join("<br>");
};
const cell = (value: string) => value.replaceAll("|", "\\|");

const sorted = [...specs].sort((a, b) => a.description.localeCompare(b.description) || stable(a.lint).localeCompare(stable(b.lint)));
const document = `# Features

Generado por \`bun run features\` a partir de \`spec_tests.json\` (las specs que registra
\`testFeature\`, ver \`src/utils/test_utils/test-feature\`). No lo edites a mano.

Cada fila es un test: **Directivas** son las del manifest que el test ejercita.

Specs: **${specs.length}** · ✅ pasan: **${count("passed")}** · 🔴 fallan: **${count("failed")}** · ⏳ sin resultado: **${count("pending")}**

| Feature | Estado | Directivas |
| --- | --- | --- |
${sorted.map((s) => `| ${cell(s.description)} | ${icon[statusOf(s)]} | ${directives(stable(s.lint))} |`).join("\n")}
`;

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
