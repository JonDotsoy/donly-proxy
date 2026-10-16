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

test("feeds request.stdin to a process in a tty and hangs it up when closed", async () => {
  const request = new ShellRequest({ commands: ["cat"], stdin: new WritableStream() });
  const response = await spawn(request);
  const writer = request.stdin!.getWriter();
  await writer.write(new TextEncoder().encode("hello\n"));
  await Bun.sleep(100);
  await writer.close();
  expect(await response.exitCode).toBe(129);
  expect(await text(response.stdout)).toContain("hello");
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

test("closes a bash with tty by signal (SIGHUP) after running a nested process", async () => {
  const bashRequest = new ShellRequest({ commands: ["bash"], stdin: new WritableStream() });
  const bash = await runLsInBash(bashRequest);

  // A terminal has no end of input: closing stdin hangs the process up (128 + SIGHUP).
  await bashRequest.stdin!.getWriter().close();
  expect(await bash.exitCode).toBe(129);
});

test("a request without stdin has no stdin and no tty", async () => {
  const request = new ShellRequest({ commands: ["cat"] });
  expect(request.stdin).toBeUndefined();
  expect(request.tty).toBe(false);
  const response = await spawn(request);
  expect(await text(response.stdout)).toBe("");
  expect(await response.exitCode).toBe(0);
  expect(() => SystemSpawn.fromResponse(response)).toThrow("no stdin");
});

test("a request with stdin runs in a tty", () => {
  expect(new ShellRequest({ commands: ["cat"], stdin: new WritableStream() }).tty).toBe(true);
});

test("nested processes never go through a shell", async () => {
  const bashRequest = new ShellRequest({ commands: ["bash"], stdin: new WritableStream() });
  const bash = await spawn(bashRequest);
  const system = SystemSpawn.fromResponse(bash);
  const echo = await spawn(new ShellRequest({ commands: ["echo", "$(echo x)'; echo y"], env: { A: "1" } }), { system });
  // The tty of the parent shell turns "\n" into "\r\n".
  expect((await text(echo.stdout)).replaceAll("\r", "")).toBe("$(echo x)'; echo y\n");
  await bashRequest.stdin!.getWriter().close();
  expect(await bash.exitCode).toBe(129);
});

test("nested processes never go through a shell, closing the bash by signal", async () => {
  const controller = new AbortController();
  const bashRequest = new ShellRequest({ commands: ["bash"], stdin: new WritableStream(), signal: controller.signal });
  const bash = await spawn(bashRequest);
  const system = SystemSpawn.fromResponse(bash);
  const echo = await spawn(new ShellRequest({ commands: ["echo", "$(echo x)'; echo y"], env: { A: "1" } }), { system });
  // The tty of the parent shell turns "\n" into "\r\n".
  expect((await text(echo.stdout)).replaceAll("\r", "")).toBe("$(echo x)'; echo y\n");
  controller.abort(new SignalError("SIGHUP"));
  expect(await bash.exitCode).toBe(129);
});

test("aborting with a SignalError sends that signal", async () => {
  const controller = new AbortController();
  const response = await spawn(new ShellRequest({ commands: ["sleep", "30"], signal: controller.signal }));
  controller.abort(new SignalError("SIGKILL"));
  expect(await response.exitCode).toBe(137);
});
