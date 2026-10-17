import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { vfs } from "./vfs";

test("createTmp gives an empty directory of its own", () => {
  const a = vfs.createTmp();
  const b = vfs.createTmp();
  expect(statSync(a.cwd()).isDirectory()).toBe(true);
  expect(a.cwd()).not.toBe(b.cwd());
  a.remove();
  b.remove();
});

test("writeFile accepts the absolute path from cwd and relative paths", () => {
  const f = vfs.createTmp();
  const file = f.writeFile(join(f.cwd(), "foo"), "bar");
  expect(file).toBe(join(f.cwd(), "foo"));
  expect(readFileSync(file, "utf8")).toBe("bar");
  f.writeFile("nested/deep/baz", "qux");
  expect(f.readFile(f.path("nested", "deep", "baz"))).toBe("qux");
  expect(f.exists("nested/deep/baz")).toBe(true);
  expect(f.exists("missing")).toBe(false);
  f.remove();
});

test("remove deletes everything, and using disposes", () => {
  const f = vfs.createTmp();
  f.writeFile("foo", "x");
  f.remove();
  expect(existsSync(f.cwd())).toBe(false);
  let cwd = "";
  {
    using g = vfs.createTmp();
    cwd = g.cwd();
    expect(existsSync(cwd)).toBe(true);
  }
  expect(existsSync(cwd)).toBe(false);
});

test("writeFile takes bytes or nothing, and readFile of a missing file throws", () => {
  const f = vfs.createTmp();
  f.writeFile("bytes", new Uint8Array([104, 105]));
  expect(f.readFile("bytes")).toBe("hi");
  f.writeFile("empty");
  expect(f.readFile("empty")).toBe("");
  expect(() => f.readFile("missing")).toThrow();
  f.remove();
});

test("no path leaves the directory", () => {
  const f = vfs.createTmp();
  for (const outside of ["../escape", "a/../../escape", "/etc/vfs-escape", join(f.cwd(), "..", "escape")]) {
    expect(() => f.writeFile(outside, "x")).toThrow("outside the vfs");
    expect(() => f.readFile(outside)).toThrow("outside the vfs");
    expect(() => f.exists(outside)).toThrow("outside the vfs");
  }
  expect(() => f.path("..", "x")).toThrow("outside the vfs");
  expect(f.path("a", "..", "b")).toBe(join(f.cwd(), "b"));
  f.remove();
});

test("remove twice is harmless and releases its exit listener", () => {
  const before = process.listenerCount("exit");
  const f = vfs.createTmp();
  expect(process.listenerCount("exit")).toBe(before + 1);
  f.remove();
  f.remove();
  expect(process.listenerCount("exit")).toBe(before);
});
