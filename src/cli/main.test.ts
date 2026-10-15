import { describe, expect, test } from "bun:test";
import pkg from "../../package.json";

const run = (...args: string[]) =>
  Bun.spawnSync(["bun", "src/cli/main.ts", ...args], { cwd: new URL("../..", import.meta.url).pathname });

describe("cli", () => {
  for (const flag of ["--version", "-V"]) {
    test(`${flag} imprime la versión y sale con 0`, () => {
      const result = run(flag);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe(pkg.version);
    });
  }

  test("--help menciona --version", () => {
    const result = run("--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("--version");
  });
});
