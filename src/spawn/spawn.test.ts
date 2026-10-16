import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { ShellRequest, SystemSpawn, spawn } from "./index";

const text = (stream: ReadableStream<Uint8Array>) => new Response(stream).text();

test("runs a process and exposes pid, stdout, stderr and exitCode", async () => {
  const response = await spawn(new ShellRequest({ commands: ["sh", "-c", "echo out; echo err >&2; exit 3"] }));
  expect(response.pid).toBeGreaterThan(0);
  expect(await text(response.stdout)).toBe("out\n");
  expect(await text(response.stderr)).toBe("err\n");
  expect(await response.exitCode).toBe(3);
});

test("passes env and cwd without a shell", async () => {
  const cwd = realpathSync(mkdtempSync(`${tmpdir()}/donly-spawn-`));
  const response = await spawn(
    new ShellRequest({ commands: ["sh", "-c", 'printf "%s %s" "$A" "$(pwd)"'], env: { A: "$(echo injected)" }, cwd }),
    { system: SystemSpawn.defaultChildProcess },
  );
  expect(await text(response.stdout)).toBe(`$(echo injected) ${cwd}`);
});

test("feeds request.stdin to the process and ends with it", async () => {
  const request = new ShellRequest({ commands: ["cat"] });
  const response = await spawn(request);
  const writer = request.stdin.getWriter();
  await writer.write(new TextEncoder().encode("hello"));
  await writer.close();
  expect(await text(response.stdout)).toBe("hello");
  expect(await response.exitCode).toBe(0);
});

test("a request copy overrides the options of the original", async () => {
  const base = new ShellRequest({ commands: ["sh", "-c", 'printf "$A$B"'], env: { A: "a", B: "b" } });
  const copy = new ShellRequest(base, { env: { B: "c" } });
  expect(copy.env).toEqual({ A: "a", B: "c" });
  expect(await text((await spawn(copy)).stdout)).toBe("ac");
});

test("rejects when the program does not exist", async () => {
  expect(spawn(new ShellRequest({ commands: ["donly-no-such-program"] }))).rejects.toThrow();
});

test("runs a nested process inside a running bash", async () => {
  const bashRequest = new ShellRequest({ commands: ["bash"], tty: true });
  const bash = await spawn(bashRequest);

  const system = SystemSpawn.fromResponse(bash);
  const ls = await spawn(new ShellRequest({ commands: ["ls", "/"] }), { system });
  expect(ls.pid).toBeGreaterThan(0);
  expect(await text(ls.stdout)).toContain("usr");
  expect(await ls.exitCode).toBe(0);

  const fail = await spawn(new ShellRequest({ commands: ["sh", "-c", "exit 4"] }), { system });
  expect(await fail.exitCode).toBe(4);

  await bashRequest.stdin.getWriter().close();
  expect(await bash.exitCode).toBe(0);
});

test("nested processes never go through a shell", async () => {
  const bashRequest = new ShellRequest({ commands: ["bash"] });
  const bash = await spawn(bashRequest);
  const system = SystemSpawn.fromResponse(bash);
  const echo = await spawn(new ShellRequest({ commands: ["echo", "$(echo x)'; echo y"], env: { A: "1" } }), { system });
  expect(await text(echo.stdout)).toBe("$(echo x)'; echo y\n");
  await bashRequest.stdin.getWriter().close();
  expect(await bash.exitCode).toBe(0);
});
