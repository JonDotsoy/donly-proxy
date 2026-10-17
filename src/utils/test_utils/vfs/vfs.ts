import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** A directory of files for tests. */
export interface Vfs {
  /** Absolute path of the directory. */
  cwd(): string;
  /** Absolute path of `relative` inside the directory. */
  path(...relative: string[]): string;
  /** Writes a file, creating the folders it needs. A relative path is relative to `cwd()`. */
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
  const resolve = (path: string) => (isAbsolute(path) ? path : join(root, path));
  const remove = () => rmSync(root, { recursive: true, force: true });
  process.once("exit", remove);
  return {
    cwd: () => root,
    path: (...relative) => join(root, ...relative),
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
