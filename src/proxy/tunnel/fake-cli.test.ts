import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "../server";
import { testFeature } from "../../utils/test_utils/test-feature/test-feature";
import { run } from "./run";
import { createFakeCli, withEnv } from "../../utils/test_utils/fake-cli/fake-cli";

// Suite over dummy `kubectl` and `ssh` binaries: failures, scripted answers and logging, with no cluster or network.
const dir = mkdtempSync(join(tmpdir(), "donly-proxy-fake-cli-"));
const fake = createFakeCli(dir);

const upstream = http.createServer(async (req, res) => {
  const body = Buffer.concat(await Array.fromAsync(req)).toString();
  res.end(JSON.stringify({ method: req.method, url: req.url, body }));
});

let proxy: string;
let upstreamPort: number;
let server: ReturnType<typeof createProxyServer>;

const manifestPayload = (port: number) => `proxy {
  host "127.0.0.1"
  port 0
  log_file "./fake-cli.ndjson"
  route http://127.0.0.1:${port}/pod-glob/* {
    kubectl_pass {
      pod_match my-pod-*
      command_pass curl
    }
  }
  route http://127.0.0.1:${port}/pod-single/* {
    kubectl_pass {
      pod_match my-pod-9?
      command_pass curl
    }
  }
  route http://127.0.0.1:${port}/pod-none/* {
    kubectl_pass {
      pod_match nope-*
      command_pass curl
    }
  }
  route http://127.0.0.1:${port}/pod-fixed/* {
    kubectl_pass "-n" "prod" "pod/api-0" {
      command_pass curl
    }
  }
  route http://127.0.0.1:${port}/ssh/* {
    ssh_pass "-p" "2222" "user@remote.test" {
      command_pass curl
    }
  }
  route http://127.0.0.1:${port}/ssh-pass/* {
    ssh_pass "user@remote.test" {
      pass "s3cret-password"
      command_pass curl
    }
  }
}
`;
const payload = manifestPayload(8080);

const logLines = () =>
  readFileSync(join(dir, "fake-cli.ndjson"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const get = (path: string) => fetch(`http://127.0.0.1:${upstreamPort}${path}`, { proxy });

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
  writeFileSync(join(dir, "manifest.donly"), manifestPayload(upstreamPort));
  fake.install();
  server = createProxyServer(await loadConfig(join(dir, "manifest.donly")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => fake.reset());

afterAll(() => {
  fake.uninstall();
  server.close();
  upstream.close();
});

testFeature(payload, ["/proxy/route/kubectl_pass/pod_match"], "should run in the first listed pod that matches the pod_match glob and skip the others", async () => {
  const res = await get("/pod-glob/x");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ method: "GET", url: "/pod-glob/x" });
  expect(fake.count("kubectl", "get")).toBe(1);
  expect(fake.args("kubectl").slice(0, 3)).toEqual(["exec", "-i", "-q"]);
  expect(fake.args("kubectl")).toContain("pod/my-pod-12345");
  expect(fake.args("kubectl")).not.toContain("pod/other-1");
});

testFeature(payload, ["/proxy/route/kubectl_pass/pod_match"], "should treat ? in pod_match as a single character", async () => {
  const res = await get("/pod-single/x");
  expect(res.status).toBe(200);
  expect(fake.args("kubectl")).toContain("pod/my-pod-99");
});

testFeature(payload, ["/proxy/route/kubectl_pass/pod_match"], "should answer 502 and never exec when no running pod matches pod_match", async () => {
  const res = await get("/pod-none/x");
  expect(res.status).toBe(502);
  expect(await res.text()).toContain("no running pod matches pod_match nope-*");
  expect(fake.count("kubectl", "get")).toBe(1);
  expect(fake.count("kubectl")).toBe(0);
});

testFeature(payload, ["/proxy/route/kubectl_pass/pod_match"], "should answer 502 with the stderr of kubectl get pods when the lookup fails", async () => {
  await withEnv({ FAKE_KUBECTL_GET_EXIT: "1" }, async () => {
    const res = await get("/pod-glob/x");
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("kubectl get pods exited with 1: boom");
    expect(fake.count("kubectl")).toBe(0);
  });
});

testFeature(payload, ["/proxy/route/kubectl_pass"], "should answer 502 with the exit code and stderr when kubectl exec fails", async () => {
  await withEnv({ FAKE_CLI_EXIT: "137", FAKE_CLI_STDERR: "error: unable to upgrade connection: container not found" }, async () => {
    const res = await get("/pod-fixed/x");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("kubectl curl exited with 137");
    expect(text).toContain("container not found");
  });
});

testFeature(payload, ["/proxy/route/kubectl_pass"], "should answer 502 when kubectl prints something that is not a curl result", async () => {
  await withEnv({ FAKE_CLI_STDOUT: "not a curl answer" }, async () => {
    const res = await get("/pod-fixed/x");
    expect(res.status).toBe(502);
  });
});

testFeature(payload, ["/proxy/route/kubectl_pass"], "should answer every concurrent request through kubectl with its own response", async () => {
  const responses = await Promise.all(Array.from({ length: 5 }, (_, i) => get(`/pod-fixed/${i}`)));
  expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
  const urls = await Promise.all(responses.map(async (res) => (await res.json()).url));
  expect(urls).toEqual([0, 1, 2, 3, 4].map((i) => `/pod-fixed/${i}`));
  expect(fake.count("kubectl")).toBe(5);
});

testFeature(payload, ["/proxy/route/ssh_pass"], "should answer 502 with the exit code and stderr when ssh cannot connect", async () => {
  await withEnv({ FAKE_CLI_EXIT: "255", FAKE_CLI_STDERR: "ssh: connect to host remote.test port 2222: Connection refused" }, async () => {
    const res = await get("/ssh/x");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("ssh curl exited with 255");
    expect(text).toContain("Connection refused");
  });
});

testFeature(payload, ["/proxy/route/ssh_pass"], "should answer 502 when ssh prints something that is not a curl result", async () => {
  await withEnv({ FAKE_CLI_STDOUT: "Welcome to remote.test" }, async () => {
    const res = await get("/ssh/x");
    expect(res.status).toBe(502);
  });
});

testFeature(payload, ["/proxy/route/ssh_pass"], "should answer every concurrent request through ssh with its own response", async () => {
  const responses = await Promise.all(Array.from({ length: 5 }, (_, i) => get(`/ssh/${i}`)));
  expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
  const urls = await Promise.all(responses.map(async (res) => (await res.json()).url));
  expect(urls).toEqual([0, 1, 2, 3, 4].map((i) => `/ssh/${i}`));
  expect(fake.count("ssh")).toBe(5);
});

testFeature(payload, ["/proxy/log_file", "/proxy/route/ssh_pass"], "should log the ssh command and its exit code without the ssh_pass password", async () => {
  const before = logLines().length;
  expect((await get("/ssh-pass/x")).status).toBe(200);
  const lines = logLines().slice(before);
  const start = lines.find((l) => l.type === "command_start" && l.program === "ssh");
  expect(start.command.at(-2)).toBe("user@remote.test");
  const end = lines.find((l) => l.type === "command_end" && l.span_id === start.span_id);
  expect(end.exit_code).toBe(0);
  expect(fake.args("ssh")).not.toContain("s3cret-password");
  expect(JSON.stringify(lines)).not.toContain("s3cret-password");
});

testFeature(payload, ["/proxy/log_file", "/proxy/route/kubectl_pass"], "should log a failed kubectl exec with its exit code", async () => {
  const before = logLines().length;
  await withEnv({ FAKE_CLI_EXIT: "1", FAKE_CLI_STDERR: "Error from server (NotFound)" }, async () => {
    expect((await get("/pod-fixed/x")).status).toBe(502);
  });
  const lines = logLines().slice(before);
  const start = lines.find((l) => l.type === "command_start" && l.program === "kubectl");
  const end = lines.find((l) => l.type === "command_end" && l.span_id === start.span_id);
  expect(end.exit_code).toBe(1);
  expect(end.console_log.some((e: { type: string; message: string }) => e.type === "stderr" && e.message.includes("NotFound"))).toBe(true);
});

const curlHeaders = `200\n{"content-type":["text/plain"]}`;

testFeature(payload, ["/proxy/route/ssh_pass"], "should answer each request with the next stdout queued in the fake ssh, then run normally", async () => {
  fake.next("ssh", { stdout: "first", stderr: curlHeaders });
  fake.next("ssh", { stdout: "second", stderr: curlHeaders });
  expect(fake.pending("ssh")).toBe(2);
  expect(await (await get("/ssh/a")).text()).toBe("first");
  expect(await (await get("/ssh/b")).text()).toBe("second");
  expect(fake.pending("ssh")).toBe(0);
  expect(await (await get("/ssh/c")).json()).toMatchObject({ url: "/ssh/c" });
  expect(fake.count("ssh")).toBe(3);
});

testFeature(payload, ["/proxy/route/ssh_pass"], "should fail only the request whose turn has a queued failure in the fake ssh", async () => {
  fake.next("ssh", { exit: 255, stderr: "Connection refused" });
  const failed = await get("/ssh/a");
  expect(failed.status).toBe(502);
  expect(await failed.text()).toContain("Connection refused");
  expect((await get("/ssh/b")).status).toBe(200);
});

testFeature(payload, ["/proxy/route/kubectl_pass/pod_match"], "should use the pods queued for the next kubectl get pods of the fake", async () => {
  fake.next("kubectl", { stdout: "pod/my-pod-7\n" }, "get");
  expect((await get("/pod-glob/x")).status).toBe(200);
  expect(fake.args("kubectl")).toContain("pod/my-pod-7");
  expect(fake.pending("kubectl", "get")).toBe(0);
  // The queue is empty again: the default listing is back.
  expect((await get("/pod-glob/y")).status).toBe(200);
  expect(fake.args("kubectl")).toContain("pod/my-pod-12345");
});

testFeature(payload, ["/proxy/route/kubectl_pass/pod_match", "/proxy/route/kubectl_pass/command_pass"], "should run the nested curl in the pod the fake kubectl lists and feed it the request body on stdin", async () => {
  fake.next("kubectl", { stdout: "pod/other-1\npod/my-pod-7\n" }, "get");
  const res = await fetch(`http://127.0.0.1:${upstreamPort}/pod-glob/nested`, { proxy, method: "POST", body: "hello from stdin" });
  expect(res.status).toBe(200);
  // The upstream got the body that travelled over the stdin of kubectl exec into curl.
  expect(await res.json()).toMatchObject({ method: "POST", url: "/pod-glob/nested", body: "hello from stdin" });
  expect(fake.stdin("kubectl")).toBe("hello from stdin");
  const args = fake.args("kubectl");
  expect(args.slice(0, args.indexOf("--"))).toEqual(["exec", "-i", "-q", "pod/my-pod-7"]);
  expect(args.at(-1)).toContain("curl -K");
  expect(fake.count("kubectl", "get")).toBe(1);
});

test("the fake ssh keeps the stdin of the remote command", async () => {
  const sent = await run("ssh", ["host", "cat"], "typed on stdin");
  expect(sent.stdout.toString()).toBe("typed on stdin");
  expect(fake.stdin("ssh")).toBe("typed on stdin");
});

// Bun.$ is used only here, in the tests, to call the fake binaries the way a person would from a terminal.
test("Bun.$ gets the version of the fake kubectl as text", async () => {
  expect(await Bun.$`kubectl --version`.text()).toBe("Client Version: v0.0.0-fake\n");
});

test("Bun.$ gets the queued stdout of the fake kubectl and then the real output of the remote command", async () => {
  // `-i` makes kubectl read stdin: give it an empty one instead of the stdin of the test runner.
  const exec = () => Bun.$`kubectl exec -i pod/x -- echo real < ${new Response("")}`.text();
  fake.next("kubectl", { stdout: "queued answer" });
  expect(await exec()).toBe("queued answer");
  expect(await exec()).toBe("real\n");
});

test("Bun.$ feeds stdin to the remote command of the fake ssh and the fake keeps it", async () => {
  expect(await Bun.$`ssh host cat < ${new Response("from Bun.$")}`.text()).toBe("from Bun.$");
  expect(fake.stdin("ssh")).toBe("from Bun.$");
});

test("Bun.$ sees the queued failure of the fake ssh", async () => {
  fake.next("ssh", { exit: 255, stderr: "Connection refused" });
  const failed = await Bun.$`ssh host true`.nothrow().quiet();
  expect(failed.exitCode).toBe(255);
  expect(failed.stderr.toString()).toContain("Connection refused");
});

test("the fake kubectl answers --version and fails cleanly without a command after --", async () => {
  const version = await run("kubectl", ["--version"], "");
  expect(version.code).toBe(0);
  expect(version.stdout.toString()).toContain("Client Version");
  const bare = await run("kubectl", ["exec", "-i", "pod/x"], "");
  expect(bare.code).toBe(1);
  expect(bare.stderr.toString()).toContain("needs a command after --");
});

test("concurrent calls with different bodies each feed their own body to the remote command", async () => {
  const bodies = Array.from({ length: 8 }, (_, i) => `body-${i}-${"x".repeat(2000 + i)}`);
  const outputs = await Promise.all([
    ...bodies.map((body) => run("kubectl", ["exec", "-i", "pod/x", "--", "cat"], body)),
    ...bodies.map((body) => run("ssh", ["host", "cat"], body)),
  ]);
  expect(outputs.map((out) => out.stdout.toString())).toEqual([...bodies, ...bodies]);
  expect(bodies).toContain(fake.stdin("kubectl"));
  expect(bodies).toContain(fake.stdin("ssh"));
});

test("FAKE_CLI_* variables fail kubectl exec and ssh but not kubectl get", async () => {
  await withEnv({ FAKE_CLI_EXIT: "9", FAKE_CLI_STDERR: "env failure", FAKE_CLI_STDOUT: "env stdout" }, async () => {
    const get = await run("kubectl", ["get", "pods", "-o", "name"], "");
    expect(get.code).toBe(0);
    expect(get.stdout.toString()).toContain("pod/my-pod-12345");
    for (const [program, args] of [["kubectl", ["exec", "-i", "pod/x", "--", "true"]], ["ssh", ["host", "true"]]] as const) {
      const failed = await run(program, [...args], "");
      expect(failed.code).toBe(9);
      expect(failed.stderr.toString()).toContain("env failure");
    }
  });
});

test("each queued answer is used by exactly one of many concurrent calls", async () => {
  for (let i = 0; i < 6; i++) fake.next("ssh", { stdout: `answer-${i}` });
  const outputs = await Promise.all(Array.from({ length: 10 }, () => run("ssh", ["host", "echo real"], "")));
  const texts = outputs.map((out) => out.stdout.toString());
  expect(texts.filter((text) => text.startsWith("answer-")).sort()).toEqual(Array.from({ length: 6 }, (_, i) => `answer-${i}`));
  expect(texts.filter((text) => text === "real\n")).toHaveLength(4);
  expect(fake.pending("ssh")).toBe(0);
});

test("reset forgets the calls and the queued answers", async () => {
  fake.next("ssh", { stdout: "never used" });
  await run("ssh", ["other", "true"], "");
  fake.next("ssh", { stdout: "queued after the call" });
  fake.reset();
  expect(fake.pending("ssh")).toBe(0);
  expect(fake.count("ssh")).toBe(0);
  fake.next("ssh", { stdout: "after reset" });
  expect((await run("ssh", ["host", "true"], "")).stdout.toString()).toBe("after reset");
});

test("FAKE_KUBECTL_PODS changes what kubectl get lists", async () => {
  await withEnv({ FAKE_KUBECTL_PODS: "pod/a\\npod/b" }, async () => {
    expect((await run("kubectl", ["get", "pods", "-o", "name"], "")).stdout.toString()).toBe("pod/a\npod/b\n");
  });
});

test("a queued answer with only stderr prints it and then behaves normally", async () => {
  fake.next("ssh", { stderr: "warning only" });
  const out = await run("ssh", ["host", "echo real"], "");
  expect(out.stderr.toString()).toContain("warning only");
  expect(out.stdout.toString()).toBe("real\n");
  expect(out.code).toBe(0);
});

test("a queued exit without stdout still ends the call and the stdin sent to it does not break the caller", async () => {
  fake.next("ssh", { exit: 7, stderr: "stopped" });
  const out = await run("ssh", ["host", "true"], "x".repeat(200_000));
  expect(out.code).toBe(7);
  expect(out.stderr.toString()).toContain("stopped");
});

test("the fake kubectl reads stdin only with -i or --stdin, also bundled, and not after --", async () => {
  const read = async (...flags: string[]) => {
    await run("kubectl", ["exec", ...flags, "pod/x", "--", "cat"], "typed");
    return fake.stdin("kubectl");
  };
  expect(await read()).toBe("");
  expect(await read("-i")).toBe("typed");
  expect(await read("--stdin")).toBe("typed");
  expect(await read("-it")).toBe("typed");
  const after = await run("kubectl", ["exec", "pod/x", "--", "cat", "-i"], "typed");
  expect(after.stdout.toString()).toBe("");
  expect(fake.stdin("kubectl")).toBe("");
});

test("withEnv restores the variables when the function throws and keeps the previous value", async () => {
  process.env.WITH_ENV_BEFORE = "before";
  delete process.env.WITH_ENV_NEW;
  await expect(
    withEnv({ WITH_ENV_BEFORE: "during", WITH_ENV_NEW: "new" }, async () => {
      expect(process.env.WITH_ENV_NEW).toBe("new");
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(process.env.WITH_ENV_BEFORE).toBe("before");
  expect("WITH_ENV_NEW" in process.env).toBe(false);
  delete process.env.WITH_ENV_BEFORE;
});

test("uninstall restores the PATH and NO_PROXY the install changed", () => {
  const other = createFakeCli(mkdtempSync(join(tmpdir(), "donly-proxy-fake-cli-other-")));
  const before = { PATH: process.env.PATH, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  other.install();
  expect(process.env.PATH).not.toBe(before.PATH);
  expect(process.env.PATH!.startsWith(join(dir, "..")) || process.env.PATH!.includes("fake-bin")).toBe(true);
  expect(process.env.NO_PROXY).toBe("");
  other.uninstall();
  expect(process.env.PATH).toBe(before.PATH);
  expect(process.env.NO_PROXY).toBe(before.NO_PROXY);
  expect(process.env.no_proxy).toBe(before.no_proxy);
});
