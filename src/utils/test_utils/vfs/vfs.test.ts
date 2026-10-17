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
