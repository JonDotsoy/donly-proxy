import { afterAll, beforeAll, beforeEach, expect } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "../../server";
import { testFeature } from "../../../utils/test_utils/test-feature/test-feature";
import { createFakeCli, withEnv } from "../../../utils/test_utils/fake-cli/fake-cli";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-kubectl-"));
const evilFile = join(dir, "pwned");
const fake = createFakeCli(dir);

const upstream = http.createServer(async (req, res) => {
  const body = Buffer.concat(await Array.fromAsync(req)).toString();
  res.setHeader("x-upstream", "yes");
  res.end(JSON.stringify({ method: req.method, url: req.url, custom: req.headers["x-custom"], body }));
});

let server: ReturnType<typeof createProxyServer>;
let proxy: string;
let port: number;

const manifest = (route: string) => `proxy {\n  host "127.0.0.1"\n  port 0\n${route}\n}\n`;

const manifestPayload = (port: number) =>
  manifest(`  route http://127.0.0.1:${port}/curl/* {
    command_pass kubectl "-n" "prod" "--context" "dev" "deploy/api" {
      engine curl
    }
  }
  route http://127.0.0.1:${port}/node/* {
    command_pass kubectl "pod/api-0" {
      engine node
    }
  }
  route http://127.0.0.1:${port}/pass/* {
    kubectl_pass "-n" "prod" "deploy/api" {
      command_pass curl "--max-time" "5"
    }
  }
  route http://127.0.0.1:${port}/podname/* {
    kubectl_pass {
      pod_name "my-pod-12345"
      context local-my-context
      namespace the-namespace
      command_pass curl
    }
  }
  route http://127.0.0.1:${port}/podmatch/* {
    kubectl_pass {
      pod_match my-pod-*
      context local-my-context
      namespace the-namespace
      command_pass curl
    }
  }
  route http://127.0.0.1:${port}/default/* {
    command_pass kubectl "pod/api-0"
  }`);

// Representative payload of the tests below (they use the port of a real upstream).
const payload = manifestPayload(8080);

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  port = (upstream.address() as AddressInfo).port;
  writeFileSync(join(dir, "manifest.donly"), manifestPayload(port));
  fake.install();
  server = createProxyServer(await loadConfig(join(dir, "manifest.donly")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  fake.uninstall();
  server.close();
  upstream.close();
});

beforeEach(() => fake.reset());

const kubectlArgs = () => fake.args("kubectl");

for (const engine of ["curl", "node"] as const) {
  testFeature(payload, ["/proxy/route/command_pass/engine"], `command_pass kubectl with engine ${engine} runs the request inside the pod`, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/${engine}/path?x=1`, {
      proxy,
      method: "POST",
      body: "payload",
      headers: { "x-custom": "abc" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upstream")).toBe("yes");
    expect(await res.json()).toEqual({ method: "POST", url: `/${engine}/path?x=1`, custom: "abc", body: "payload" });

    // kubectl exec -i -q [options] <target> -- <command…>
    const args = kubectlArgs();
    expect(args.slice(0, 3)).toEqual(["exec", "-i", "-q"]);
    const separator = args.indexOf("--");
    expect(args[separator - 1]).toBe(engine === "curl" ? "deploy/api" : "pod/api-0");
    if (engine === "curl") {
      expect(args.slice(3, separator - 1)).toEqual(["-n", "prod", "--context", "dev"]);
      expect(args.slice(separator + 1, separator + 3)).toEqual(["sh", "-c"]);
      expect(args.at(-1)).toContain("curl -K");
    } else {
      expect(args.slice(separator + 1)).toEqual(["node", "--input-type=module", "-"]);
    }
  });
}

testFeature(payload, ["/proxy/route/command_pass"], "command_pass kubectl uses curl when no engine is given", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/default/`, { proxy });
  expect((await res.json()).url).toBe("/default/");
  expect(kubectlArgs().at(-1)).toContain("curl -K");
});

testFeature(payload, ["/proxy/route/command_pass"], "request data never reaches the command line or a shell", async () => {
  const evil = `'; touch ${evilFile}; echo '`;
  for (const route of ["curl", "node"]) {
    const res = await fetch(`http://127.0.0.1:${port}/${route}/${encodeURIComponent(evil)}$(touch%20${evilFile})`, {
      proxy,
      method: "POST",
      body: evil,
      headers: { "x-custom": evil },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).custom).toBe(evil);
    const commandLine = kubectlArgs().join(" ");
    expect(commandLine).not.toContain(port.toString());
    expect(commandLine).not.toContain("touch");
  }
  expect(existsSync(evilFile)).toBe(false);
});

testFeature(payload, ["/proxy/route/command_pass"], "kubectl failures are reported as a bad gateway", async () => {
  fake.next("kubectl", { stderr: 'Error from server (NotFound): pods "api-0" not found\n', exit: 1 });
  const res = await fetch(`http://127.0.0.1:${port}/curl/`, { proxy });
  expect(res.status).toBe(502);
  expect(await res.text()).toContain('kubectl curl exited with 1: Error from server (NotFound): pods "api-0" not found');
});

testFeature(manifest(`  route / {\n command_pass kubectl\n }`), ["/proxy/route/command_pass"], "manifest validation for kubectl", async () => {
  const load = (route: string) => {
    const file = join(dir, `v-${Math.random()}.donly`);
    writeFileSync(file, manifest(route));
    return loadConfig(file);
  };
  expect(load(`route / {\n command_pass kubectl\n }`)).rejects.toThrow("pod o tipo/nombre");
  expect(load(`route / {\n command_pass kubectl pod/x {\n engine perl\n }\n }`)).rejects.toThrow("engine solo soporta");
});

testFeature(payload, ["/proxy/route/kubectl_pass"], "kubectl_pass with a nested command_pass curl runs the request inside the pod with the curl options", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/pass/path?x=1`, { proxy, method: "POST", body: "payload" });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ method: "POST", url: "/pass/path?x=1", body: "payload" });
  const args = kubectlArgs();
  expect(args.slice(0, 6)).toEqual(["exec", "-i", "-q", "-n", "prod", "deploy/api"]);
  expect(args.slice(args.indexOf("--") + 1, args.indexOf("--") + 3)).toEqual(["sh", "-c"]);
  expect(args.at(-1)).toContain("curl -K");
  expect(args.at(-1)).toContain("'--max-time' '5'");
});

testFeature(payload, ["/proxy/route/kubectl_pass/pod_name"], "kubectl_pass without a positional argument takes the pod from pod_name", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/podname/path`, { proxy });
  expect(res.status).toBe(200);
  const args = kubectlArgs();
  expect(args.slice(0, args.indexOf("--"))).toEqual(["exec", "-i", "-q", "--context", "local-my-context", "--namespace", "the-namespace", "my-pod-12345"]);
});

testFeature(payload, ["/proxy/route/kubectl_pass/pod_match"], "kubectl_pass with pod_match lists the pods and runs in the first one that matches", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/podmatch/path`, { proxy });
  expect(res.status).toBe(200);
  const get = fake.args("kubectl", "get");
  expect(get).toEqual(["get", "pods", "--context", "local-my-context", "--namespace", "the-namespace", "--field-selector=status.phase=Running", "-o", "name"]);
  const args = kubectlArgs();
  expect(args.slice(0, args.indexOf("--"))).toEqual(["exec", "-i", "-q", "--context", "local-my-context", "--namespace", "the-namespace", "pod/my-pod-12345"]);
});

const podMatchLogPayload = (port: number) => `proxy {
  host "127.0.0.1"
  port 0
  log_file "./podmatch.ndjson"
  route http://127.0.0.1:${port}/* {
    kubectl_pass {
      pod_match my-pod-*
      context local-my-context
      namespace the-namespace
      command_pass curl
    }
  }
}
`;

testFeature(podMatchLogPayload(8080), ["/proxy/log_file", "/proxy/route/kubectl_pass/pod_match"], "kubectl_pass with pod_match logs the kubectl get pods command before the kubectl exec", async () => {
  writeFileSync(join(dir, "podmatch.donly"), podMatchLogPayload(port));
  const logging = createProxyServer(await loadConfig(join(dir, "podmatch.donly")));
  await new Promise<void>((resolve) => logging.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/x`, { proxy: `http://127.0.0.1:${(logging.address() as AddressInfo).port}` });
    expect(res.status).toBe(200);
    const lines = readFileSync(join(dir, "podmatch.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const starts = lines.filter((l) => l.type === "command_start");
    const lookup = starts.find((l) => l.args[0] === "get");
    expect(lookup.program).toBe("kubectl");
    expect(lookup.command).toEqual(["kubectl", "get", "pods", "--context", "local-my-context", "--namespace", "the-namespace", "--field-selector=status.phase=Running", "-o", "name"]);
    // It runs before the exec and is closed with the listing it printed.
    expect(starts.indexOf(lookup)).toBeLessThan(starts.findIndex((l) => l.args[0] === "exec"));
    const end = lines.find((l) => l.type === "command_end" && l.span_id === lookup.span_id);
    expect(end.exit_code).toBe(0);
    expect(end.console_log.some((e: { type: string; message: string }) => e.type === "stdout" && e.message.includes("pod/my-pod-12345"))).toBe(true);
  } finally {
    logging.close();
  }
});

testFeature(payload, ["/proxy/route/kubectl_pass/pod_match"], "kubectl_pass with pod_match answers 502 when kubectl get pods fails", async () => {
  await withEnv({ FAKE_KUBECTL_GET_EXIT: "1" }, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/podmatch/path`, { proxy });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("kubectl get pods exited with 1");
  });
});

testFeature(manifest(`  route / {\n kubectl_pass {\n pod_match ""\n command_pass curl\n }\n }`), ["/proxy/route/kubectl_pass/pod_match"], "manifest validation for pod_match", async () => {
  const load = (route: string) => {
    const file = join(dir, `v-${Math.random()}.donly`);
    writeFileSync(file, manifest(route));
    return loadConfig(file);
  };
  await expect(load(`route / {\n kubectl_pass {\n pod_match ""\n command_pass curl\n }\n }`)).rejects.toThrow("pod_match debe ser un patrón");
  await expect(load(`route / {\n kubectl_pass {\n pod_name x\n pod_match "x*"\n command_pass curl\n }\n }`)).rejects.toThrow("no se pueden combinar");
});

testFeature(manifest(`  route / {\n kubectl_pass {\n command_pass curl\n }\n }`), ["/proxy/route/kubectl_pass/pod_name"], "manifest validation for pod_name", async () => {
  const load = (route: string) => {
    const file = join(dir, `v-${Math.random()}.donly`);
    writeFileSync(file, manifest(route));
    return loadConfig(file);
  };
  await expect(load(`route / {\n kubectl_pass {\n pod_name ""\n command_pass curl\n }\n }`)).rejects.toThrow("pod_name debe ser un nombre");
  await expect(load(`route / {\n kubectl_pass {\n pod_name 5\n command_pass curl\n }\n }`)).rejects.toThrow("pod_name debe ser un nombre");
});

testFeature(manifest(`  route / {\n kubectl_pass {\n command_pass curl\n }\n }`), ["/proxy/route/kubectl_pass"], "manifest validation for kubectl_pass", async () => {
  const load = (route: string) => {
    const file = join(dir, `v-${Math.random()}.donly`);
    writeFileSync(file, manifest(route));
    return loadConfig(file);
  };
  expect(load(`route / {\n kubectl_pass {\n command_pass curl\n }\n }`)).rejects.toThrow("pod o tipo/nombre");
  expect(load(`route / {\n kubectl_pass pod/x\n }`)).rejects.toThrow("requiere un command_pass hijo");
  expect(load(`route / {\n kubectl_pass pod/x {\n command_pass ssh\n }\n }`)).rejects.toThrow('no "ssh"');
  expect(load(`route / {\n kubectl_pass pod/x {\n command_pass curl {\n concurrency 0\n }\n }\n }`)).rejects.toThrow("entero positivo");
  expect(load(`route / {\n respond 200 "x"\n kubectl_pass pod/x {\n command_pass curl\n }\n }`)).rejects.toThrow("exactamente uno");
});

const consolePayload = (port: number) => `proxy {
  host "127.0.0.1"
  port 0
  log_file "./console.ndjson"
  route http://127.0.0.1:${port}/* {
    command_pass kubectl "pod/api-0"
  }
}
`;

testFeature(consolePayload(8080), ["/proxy/log_file", "/proxy/route/command_pass"], "kubectl command_end logs the console (stdout, stderr and stdin) without changing the response", async () => {
  fake.next("kubectl", { stderr: "kubectl-warning\n" });
  writeFileSync(join(dir, "console.donly"), consolePayload(port));
  const logging = createProxyServer(await loadConfig(join(dir, "console.donly")));
  await new Promise<void>((resolve) => logging.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/x`, {
      proxy: `http://127.0.0.1:${(logging.address() as AddressInfo).port}`,
      method: "POST",
      body: "payload",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upstream")).toBe("yes");
    expect(await res.json()).toMatchObject({ method: "POST", url: "/x", body: "payload" });

    const lines = readFileSync(join(dir, "console.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const exits = lines.filter((l) => l.type === "command_end");
    // Both lines (the remote command and kubectl itself) carry the same list: one process wrote it.
    expect(exits).toHaveLength(2);
    expect(exits[1].program).toBe("kubectl");
    expect(exits[0].exit_code).toBe(0);
    expect(exits[0].console_log).toEqual(exits[1].console_log);
    const log: { type: string; message: string }[] = exits[1].console_log;
    expect(log.some((e) => e.type === "stdin" && e.message.includes("payload"))).toBe(true);
    expect(log.some((e) => e.type === "stderr" && e.message.includes("kubectl-warning"))).toBe(true);
    expect(log.some((e) => e.type === "stdout" && e.message.includes('"url":"/x"'))).toBe(true);
    // The response line the client's answer comes from carries no console_log.
    expect(lines.find((l) => l.type === "response").console_log).toBeUndefined();
  } finally {
    logging.close();
  }
});
