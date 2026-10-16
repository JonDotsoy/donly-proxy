import { expect, test } from "bun:test";
import { createLogger_experimental } from "../proxy/logger";
import { ShellRequest, spawn } from "./index";

const setup = () => {
  const chunks: Uint8Array[] = [];
  const Logger = createLogger_experimental(new WritableStream({ write: (chunk) => void chunks.push(chunk) }));
  const transaction = Logger.request.openTransaction({ method: "GET", url: "http://a.test/", httpVersion: "1.1", headers: {}, body: Buffer.alloc(0) });
  const lines = async () => {
    await Logger.flush();
    return Buffer.concat(chunks).toString().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };
  return { transaction, lines };
};

const drain = (response: Awaited<ReturnType<typeof spawn>>) => Promise.all([new Response(response.stdout).text(), new Response(response.stderr).text(), response.exitCode]);

test("a logged ShellRequest writes command_start and command_end with its console and exit code", async () => {
  const { transaction, lines } = setup();
  const request = new ShellRequest({ commands: ["sh", "-c", "cat; echo out; echo err >&2; exit 4"], stdin: new WritableStream() });
  const response = await spawn(request, { logger: { parent: transaction } });
  const writer = request.stdin!.getWriter();
  await writer.write(new TextEncoder().encode("in\n"));
  await writer.close();
  expect(await drain(response)).toEqual(["in\nout\n", "err\n", 4]);

  await Bun.sleep(50);
  const [, start, end] = await lines();
  expect(start).toMatchObject({ type: "command_start", program: "sh", args: ["-c", "cat; echo out; echo err >&2; exit 4"], parent_span_id: transaction.spanId });
  expect(end).toMatchObject({ type: "command_end", span_id: start.span_id, program: "sh", exit_code: 4 });
  const text = (type: string) => end.console_log.filter((e: any) => e.type === type).map((e: any) => e.message).join("");
  expect([text("stdin"), text("stdout"), text("stderr")]).toEqual(["in\n", "in\nout\n", "err\n"]);
});

test("a process that cannot start still closes its command with a null exit code and the error", async () => {
  const { transaction, lines } = setup();
  await expect(spawn(new ShellRequest({ commands: ["/nonexistent/donly-binary"] }), { logger: { parent: transaction } })).rejects.toThrow();
  const [, start, end] = await lines();
  expect(start.type).toBe("command_start");
  expect(end).toMatchObject({ type: "command_end", span_id: start.span_id, exit_code: null });
  expect(end.console_log[0].type).toBe("stderr");
});

test("a custom opener can log a nested process that ends with the same result", async () => {
  const { transaction, lines } = setup();
  const logger = {
    parent: transaction,
    open: (r: ShellRequest) => {
      const outer = transaction.command.openTransaction({ program: r.commands[0], args: r.commands.slice(1) });
      return [outer, outer.command.openTransaction({ program: "inner", args: [] })];
    },
  };
  await drain(await spawn(new ShellRequest({ commands: ["sh", "-c", "echo hi"] }), { logger }));
  await Bun.sleep(50);
  const all = await lines();
  expect(all.map((l) => `${l.type}:${l.program}`)).toEqual(["request:undefined", "command_start:sh", "command_start:inner", "command_end:inner", "command_end:sh"]);
  expect(all[3].exit_code).toBe(0);
  expect(all[4].console_log).toEqual(all[3].console_log);
});
