import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/** A directory of files for tests. */
export interface Vfs {
  /** Absolute path of the directory. */
  cwd(): string;
  /** Absolute path of `parts` inside the directory. */
  path(...parts: string[]): string;
  /** Writes a file, creating the folders it needs. A relative path is relative to `cwd()`; a path outside the directory throws. */
  writeFile(path: string, data?: string | Uint8Array): string;
  readFile(path: string): string;
  exists(path: string): boolean;
  /** Deletes the directory with everything in it. It also goes away when the process ends. */
  remove(): void;
  [Symbol.dispose](): void;
}

/** A temporary directory that the test fills with files; use it as `cwd` of a process. */
const createTmp = (): Vfs => {
  const root = mkdtempSync(join(tmpdir(), "donly-proxy-vfs-"));
  // Every path stays inside the directory: a test with a wrong `../` or absolute path must not touch the rest of the disk.
  const resolve = (...parts: string[]) => {
    const file = parts.length === 1 && isAbsolute(parts[0]!) ? parts[0]! : join(root, ...parts);
    const inside = relative(root, file);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error(`${file} is outside the vfs ${root}`);
    return file;
  };
  const remove = () => {
    process.off("exit", remove);
    rmSync(root, { recursive: true, force: true });
  };
  process.on("exit", remove);
  return {
    cwd: () => root,
    path: (...parts) => resolve(...parts),
    writeFile(path, data = "") {
      const file = resolve(path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, data);
      return file;
    },
    readFile: (path) => readFileSync(resolve(path), "utf8"),
    exists: (path) => existsSync(resolve(path)),
    remove,
    [Symbol.dispose]: remove,
  };
};

export const vfs = { createTmp };
