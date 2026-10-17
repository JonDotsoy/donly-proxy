import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import pkg from "../../package.json";

const root = new URL("../..", import.meta.url).pathname;
const run = (...args: string[]) => Bun.spawnSync(["bun", "src/cli/main.ts", ...args], { cwd: root });
const runIn = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["bun", join(root, "src/cli/main.ts"), ...args], { cwd });

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

  test("sin argumentos y sin proxy.donly falla indicando el archivo y la ruta", () => {
    const dir = mkdtempSync(join(tmpdir(), "donly-cli-"));
    const result = runIn(dir);
    expect(result.exitCode).toBe(1);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("proxy.donly");
    expect(stderr).toContain(join(dir, "proxy.donly"));
  });

  test("sin argumentos carga proxy.donly del directorio actual", async () => {
    const dir = mkdtempSync(join(tmpdir(), "donly-cli-"));
    writeFileSync(join(dir, "proxy.donly"), 'proxy {\n  host "127.0.0.1"\n  port 0\n}\n');
    const child = Bun.spawn(["bun", join(root, "src/cli/main.ts")], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    child.kill();
    expect(new TextDecoder().decode(value)).toContain("proxy listening on 127.0.0.1:");
    expect(await new Response(child.stderr).text()).toContain(`leyendo manifiesto ${join(dir, "proxy.donly")} (por defecto)`);
  });
});
