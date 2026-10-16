import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { ShellRequest, SignalError, SystemSpawn, spawn } from "./index";

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

test("feeds request.stdin to the process, which lives while the writable is open", async () => {
  const request = new ShellRequest({ commands: ["cat"], stdin: new WritableStream() });
  const response = await spawn(request);
  const writer = request.stdin!.getWriter();
  await writer.write(new TextEncoder().encode("hello\n"));
  await Bun.sleep(100);
  await writer.write(new TextEncoder().encode("world"));
  await writer.close();
  expect(await text(response.stdout)).toBe("hello\nworld");
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

const runLsInBash = async (bashRequest: ShellRequest) => {
  const bash = await spawn(bashRequest);
  const system = SystemSpawn.fromResponse(bash);
  const ls = await spawn(new ShellRequest({ commands: ["ls", "/"] }), { system });
  expect(ls.pid).toBeGreaterThan(0);
  expect(await text(ls.stdout)).toContain("usr");
  expect(await ls.exitCode).toBe(0);

  const fail = await spawn(new ShellRequest({ commands: ["sh", "-c", "exit 4"] }), { system });
  expect(await fail.exitCode).toBe(4);
  return bash;
};

test("closes a bash by closing its stdin after running a nested process", async () => {
  const bashRequest = new ShellRequest({ commands: ["bash"], stdin: new WritableStream() });
  const bash = await runLsInBash(bashRequest);

  await bashRequest.stdin!.getWriter().close();
  expect(await bash.exitCode).toBe(0);
});

test("nested processes never go through a shell", async () => {
  const bashRequest = new ShellRequest({ commands: ["bash"], stdin: new WritableStream() });
  const bash = await spawn(bashRequest);
  const system = SystemSpawn.fromResponse(bash);
  const echo = await spawn(new ShellRequest({ commands: ["echo", "$(echo x)'; echo y"], env: { A: "1" } }), { system });
  expect(await text(echo.stdout)).toBe("$(echo x)'; echo y\n");
  await bashRequest.stdin!.getWriter().close();
  expect(await bash.exitCode).toBe(0);
});

test("nested processes never go through a shell, closing the bash by signal", async () => {
  const controller = new AbortController();
  const bashRequest = new ShellRequest({ commands: ["bash"], stdin: new WritableStream(), signal: controller.signal });
  const bash = await spawn(bashRequest);
  const system = SystemSpawn.fromResponse(bash);
  const echo = await spawn(new ShellRequest({ commands: ["echo", "$(echo x)'; echo y"], env: { A: "1" } }), { system });
  expect(await text(echo.stdout)).toBe("$(echo x)'; echo y\n");
  controller.abort(new SignalError("SIGHUP"));
  expect(await bash.exitCode).toBe(129);
});

test("aborting with a SignalError sends that signal", async () => {
  const controller = new AbortController();
  const response = await spawn(new ShellRequest({ commands: ["sleep", "30"], signal: controller.signal }));
  controller.abort(new SignalError("SIGKILL"));
  expect(await response.exitCode).toBe(137);
});

test("a SignalError accepts a signal number or an exit code", () => {
  expect(new SignalError(1).signal).toBe("SIGHUP");
  expect(new SignalError(129).signal).toBe("SIGHUP");
  expect(new SignalError(137).signal).toBe("SIGKILL");
  expect(() => new SignalError(999)).toThrow(RangeError);
});

test("aborting with a SignalError made of an exit code sends that signal", async () => {
  const controller = new AbortController();
  const response = await spawn(new ShellRequest({ commands: ["sleep", "30"], signal: controller.signal }));
  controller.abort(new SignalError(129));
  expect(await response.exitCode).toBe(129);
});

test("combines a controller and a timeout with AbortSignal.any: the controller wins with its SignalError", async () => {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
  const response = await spawn(new ShellRequest({ commands: ["sleep", "30"], signal }));
  controller.abort(new SignalError("SIGKILL"));
  expect(await response.exitCode).toBe(137);
});

test("combines a controller and a timeout with AbortSignal.any: the timeout ends the process with the default signal", async () => {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(100)]);
  const response = await spawn(new ShellRequest({ commands: ["sleep", "30"], signal }));
  expect(await response.exitCode).toBe(143);
});

test("a request without stdin has no stdin and the process gets the end of input", async () => {
  const request = new ShellRequest({ commands: ["cat"] });
  expect(request.stdin).toBeUndefined();
  const response = await spawn(request);
  expect(await text(response.stdout)).toBe("");
  expect(await response.exitCode).toBe(0);
  expect(() => SystemSpawn.fromResponse(response)).toThrow("no stdin");
});
