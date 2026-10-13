#!/usr/bin/env bun
/**
 * Fills the "Probada" and "Tests" columns of docs/system/features.md from the titles of
 * the tests, so the table never claims a feature is tested when it is not.
 *
 *   bun scripts/features.ts                  # runs `bun test` and rewrites the table
 *   bun scripts/features.ts --check          # same, but fails if the file is out of date
 *   bun scripts/features.ts --junit report.xml   # reuse a JUnit report instead of running the tests
 *
 * Convention: a test belongs to a feature when its title contains the feature id in square
 * brackets, e.g. `test("[proxy_pass.https] proxy_pass works through an https tunnel", ...)`.
 * A title may carry several ids. The feature ids, descriptions and the "Soportada" column are
 * written by hand in the table; every row starts with the id in backticks.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const file = join(root, "docs/system/features.md");

const args = process.argv.slice(2);
const check = args.includes("--check");
const junitArg = args.includes("--junit") ? args[args.indexOf("--junit") + 1] : undefined;

interface TestCase {
  title: string;
  passed: boolean;
}

const unescapeXml = (value: string) =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

const readTests = (): TestCase[] => {
  let report = junitArg;
  if (!report) {
    report = join(mkdtempSync(join(tmpdir(), "features-")), "junit.xml");
    const run = spawnSync("bun", ["test", "--reporter=junit", `--reporter-outfile=${report}`], {
      cwd: root,
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (run.error) throw run.error;
  }
  const xml = readFileSync(report, "utf8");
  const tests: TestCase[] = [];
  for (const [, attributes = "", inner = ""] of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const title = /\bname="([^"]*)"/.exec(attributes)?.[1];
    if (title === undefined) continue;
    tests.push({ title: unescapeXml(title), passed: !/<(failure|error)\b/.test(inner) });
  }
  return tests;
};

const tagsOf = (title: string) => [...title.matchAll(/\[([a-z0-9][a-z0-9._-]*)\]/g)].map((m) => m[1]!);
const cleanTitle = (title: string) => title.replace(/\[[a-z0-9][a-z0-9._-]*\]\s*/g, "").trim();
const cell = (value: string) => value.replaceAll("|", "\\|");

const tests = readTests();
if (tests.length === 0) {
  console.error("features: no tests found in the report");
  process.exit(1);
}

const original = readFileSync(file, "utf8");
const known = new Set<string>();
let supported = 0;
let tested = 0;

const rewritten = original
  .split("\n")
  .map((line) => {
    if (!/^\| `[^`]+` \|/.test(line)) return line;
    const cells = line.slice(1, line.lastIndexOf("|")).split(/(?<!\\)\|/).map((c) => c.trim());
    const [feature = "", description = "", support = ""] = cells;
    const id = feature.replaceAll("`", "");
    known.add(id);

    const matching = tests.filter((t) => tagsOf(t.title).includes(id));
    const status = matching.length === 0 ? "❌" : matching.every((t) => t.passed) ? "✅" : "🔴";
    if (support.startsWith("✅")) {
      supported++;
      if (status === "✅") tested++;
    }
    const titles = matching.map((t) => `${t.passed ? "" : "🔴 "}${cell(cleanTitle(t.title))}`).join("<br>");
    return `| ${feature} | ${description} | ${support} | ${status} | ${titles} |`;
  })
  .join("\n")
  .replace(
    /(<!-- features:summary -->)[\s\S]*?(<!-- \/features:summary -->)/,
    `$1\nSoportadas: **${supported}** · Soportadas y probadas: **${tested}** · Sin pruebas: **${supported - tested}**\n$2`,
  );

// Test titles that point at a feature that is not in the table (typos) or that carry no id.
const problems: string[] = [];
for (const test of tests) {
  const ids = tagsOf(test.title);
  if (ids.length === 0) problems.push(`test without a [feature-id]: "${test.title}"`);
  for (const id of ids) if (!known.has(id)) problems.push(`unknown feature [${id}] in test: "${test.title}"`);
}
const failing = tests.filter((t) => !t.passed);
for (const test of failing) problems.push(`failing test: "${test.title}"`);

if (check) {
  if (rewritten !== original) problems.push("docs/system/features.md is out of date: run `bun run features`");
} else if (rewritten !== original) {
  writeFileSync(file, rewritten);
  console.log("features: updated docs/system/features.md");
} else {
  console.log("features: docs/system/features.md is up to date");
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`features: ${problem}`);
  process.exit(1);
}
