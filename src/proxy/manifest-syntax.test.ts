import { expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

// Pins the syntax of the route actions of a manifest: what loads and what is rejected (with its exact message).
// It only goes through `loadConfig`, so it keeps holding if the actions are built in another way.
const dir = mkdtempSync(join(tmpdir(), "donly-proxy-syntax-"));
const load = (payload: string) => {
  const file = join(dir, `v-${Math.random()}.donly`);
  writeFileSync(file, payload);
  return loadConfig(file);
};
const route = (body: string) => `proxy {\n  route / {\n${body}\n  }\n}\n`;
const accepts = async (payload: string) => {
  const config = await load(payload);
  expect(config.routes.length).toBeGreaterThan(0);
};

const ONE_ACTION = "se requiere exactamente uno de `respond`, `proxy_pass`, `command_pass`, `kubectl_pass` o `ssh_pass`";

testFeature(route(`    respond 200 "ok"\n    proxy_pass "http://example.com/"`), ["/proxy/route/respond", "/proxy/route/proxy_pass"], "should reject a route with two actions", async (payload) => {
  await expect(load(payload)).rejects.toThrow(`route /: ${ONE_ACTION}`);
});

testFeature(route(`    command_pass curl\n    ssh_pass "user@host" {\n      command_pass curl\n    }`), ["/proxy/route/command_pass", "/proxy/route/ssh_pass"], "should reject command_pass together with ssh_pass", async (payload) => {
  await expect(load(payload)).rejects.toThrow(`route /: ${ONE_ACTION}`);
});

testFeature(route(``), ["/proxy/route"], "should reject a route without action", async (payload) => {
  await expect(load(payload)).rejects.toThrow(`route /: ${ONE_ACTION}`);
});

for (const name of ["curl", "node", "ssh", "kubectl"]) {
  testFeature(route(`    command_pass ${name} "host"`), ["/proxy/route/command_pass"], `should accept command_pass ${name}`, async (payload) => {
    await accepts(payload);
  });
}

testFeature(route(`    command_pass wget`), ["/proxy/route/command_pass"], "should reject command_pass wget as a command", async (payload) => {
  await expect(load(payload)).rejects.toThrow('route /: command_pass solo soporta "curl", "node", "ssh" y "kubectl", no "wget"');
});

testFeature(route(`    command_pass rsh "host"`), ["/proxy/route/command_pass"], "should reject an unknown command_pass name", async (payload) => {
  await expect(load(payload)).rejects.toThrow('route /: command_pass solo soporta "curl", "node", "ssh" y "kubectl", no "rsh"');
});

testFeature(route(`    command_pass proxy`), ["/proxy/route/command_pass"], "should keep rejecting command_pass proxy until it is a plugin", async (payload) => {
  await expect(load(payload)).rejects.toThrow('route /: command_pass solo soporta "curl", "node", "ssh" y "kubectl", no "proxy"');
});

for (const engine of ["curl", "node", "wget"]) {
  testFeature(route(`    command_pass ssh "user@host" {\n      engine ${engine}\n    }`), ["/proxy/route/command_pass/engine"], `should accept engine ${engine} in command_pass ssh`, async (payload) => {
    await accepts(payload);
  });
  testFeature(route(`    command_pass kubectl "pod/api" {\n      engine ${engine}\n    }`), ["/proxy/route/command_pass/engine"], `should accept engine ${engine} in command_pass kubectl`, async (payload) => {
    await accepts(payload);
  });
}

testFeature(route(`    command_pass ssh "user@host" {\n      engine perl\n    }`), ["/proxy/route/command_pass/engine"], "should reject an unknown engine", async (payload) => {
  await expect(load(payload)).rejects.toThrow('route /: engine solo soporta "curl", "node" y "wget", no "perl"');
});

for (const name of ["curl", "node"]) {
  testFeature(route(`    command_pass ${name} {\n      engine curl\n    }`), ["/proxy/route/command_pass/engine"], `should reject engine in command_pass ${name}`, async (payload) => {
    await expect(load(payload)).rejects.toThrow("route /: engine solo aplica a command_pass ssh y kubectl");
  });
}

testFeature(route(`    command_pass ssh`), ["/proxy/route/command_pass"], "should require the destination of command_pass ssh", async (payload) => {
  await expect(load(payload)).rejects.toThrow("route /: command_pass ssh requiere el destino (usuario@host)");
});

testFeature(route(`    command_pass kubectl`), ["/proxy/route/command_pass"], "should require the destination of command_pass kubectl", async (payload) => {
  await expect(load(payload)).rejects.toThrow("route /: command_pass kubectl requiere el destino (pod o tipo/nombre)");
});

testFeature(route(`    command_pass curl {\n      concurrency 0\n    }`), ["/proxy/route/command_pass/concurrency"], "should reject a concurrency lower than 1", async (payload) => {
  await expect(load(payload)).rejects.toThrow('route /: concurrency debe ser un entero positivo, no "0"');
});

testFeature(route(`    command_pass curl {\n      concurrency 1.5\n    }`), ["/proxy/route/command_pass/concurrency"], "should reject a fractional concurrency", async (payload) => {
  await expect(load(payload)).rejects.toThrow('route /: concurrency debe ser un entero positivo, no "1.5"');
});

testFeature(route(`    command_pass curl {\n      concurrency 4\n    }`), ["/proxy/route/command_pass/concurrency"], "should accept a positive integer concurrency", async (payload) => {
  await accepts(payload);
});

testFeature(route(`    command_pass node {\n      insecure\n    }`), ["/proxy/route/command_pass/insecure"], "should reject insecure outside command_pass curl", async (payload) => {
  await expect(load(payload)).rejects.toThrow("route /: insecure solo aplica a command_pass curl");
});

testFeature(route(`    command_pass node {\n      max_time 5\n    }`), ["/proxy/route/command_pass/max_time"], "should reject max_time outside command_pass curl", async (payload) => {
  await expect(load(payload)).rejects.toThrow("route /: max_time solo aplica a command_pass curl");
});

testFeature(route(`    command_pass node {\n      retry 3\n    }`), ["/proxy/route/command_pass/retry"], "should reject retry outside command_pass curl", async (payload) => {
  await expect(load(payload)).rejects.toThrow("route /: retry solo aplica a command_pass curl");
});

testFeature(route(`    command_pass curl {\n      no_warnings\n    }`), ["/proxy/route/command_pass/no_warnings"], "should reject no_warnings outside command_pass node", async (payload) => {
  await expect(load(payload)).rejects.toThrow("route /: no_warnings solo aplica a command_pass node");
});

testFeature(route(`    command_pass curl {\n      max_time 0\n    }`), ["/proxy/route/command_pass/max_time"], "should reject a max_time that is not positive", async (payload) => {
  await expect(load(payload)).rejects.toThrow('route /: max_time debe ser un número positivo, no "0"');
});

testFeature(route(`    command_pass curl {\n      retry -1\n    }`), ["/proxy/route/command_pass/retry"], "should reject a negative retry", async (payload) => {
  await expect(load(payload)).rejects.toThrow('route /: retry debe ser un entero no negativo, no "-1"');
});

testFeature(route(`    command_pass curl {\n      insecure 1\n    }`), ["/proxy/route/command_pass/insecure"], "should reject an insecure that is not a boolean", async (payload) => {
  await expect(load(payload)).rejects.toThrow('route /: insecure debe ser true o false, no "1"');
});

testFeature(route(`    command_pass node {\n      no_warnings "yes"\n    }`), ["/proxy/route/command_pass/no_warnings"], "should reject a no_warnings that is not a boolean", async (payload) => {
  await expect(load(payload)).rejects.toThrow('route /: no_warnings debe ser true o false, no "yes"');
});

testFeature(route(`    command_pass curl {\n      insecure true\n      max_time 5\n      retry 0\n      extra_args --foo\n    }`), ["/proxy/route/command_pass"], "should accept every option of command_pass curl", async (payload) => {
  await accepts(payload);
});

testFeature(route(`    command_pass node {\n      no_warnings true\n      extra_args --foo\n    }`), ["/proxy/route/command_pass"], "should accept every option of command_pass node", async (payload) => {
  await accepts(payload);
});

testFeature(route(`    command_pass ssh "user@host" {\n      context dev\n    }`), ["/proxy/route/command_pass/context"], "should reject context outside kubectl", async (payload) => {
  await expect(load(payload)).rejects.toThrow("route /: context solo aplica a kubectl_pass y command_pass kubectl");
});

testFeature(route(`    command_pass kubectl "pod/api" {\n      context dev\n      namespaces prod\n    }`), ["/proxy/route/command_pass/namespace"], "should accept context and the namespaces alias in command_pass kubectl", async (payload) => {
  await accepts(payload);
});

testFeature(route(`    kubectl_pass "pod/api" {\n      command_pass curl\n    }`), ["/proxy/route/kubectl_pass"], "should accept kubectl_pass with a curl command_pass child", async (payload) => {
  await accepts(payload);
});

for (const engine of ["curl", "wget", "node"]) {
  testFeature(route(`    kubectl_pass "pod/api" {\n      command_pass ${engine}\n    }`), ["/proxy/route/kubectl_pass"], `should accept ${engine} as the child of kubectl_pass`, async (payload) => {
    await accepts(payload);
  });
  testFeature(route(`    ssh_pass "user@host" {\n      command_pass ${engine}\n    }`), ["/proxy/route/ssh_pass"], `should accept ${engine} as the child of ssh_pass`, async (payload) => {
    await accepts(payload);
  });
}

testFeature(route(`    kubectl_pass "pod/api" {\n      command_pass ssh\n    }`), ["/proxy/route/kubectl_pass"], "should reject a child of kubectl_pass that is not an engine", async (payload) => {
  await expect(load(payload)).rejects.toThrow('route /: kubectl_pass requiere un command_pass hijo con "curl", "wget" o "node", no "ssh"');
});

testFeature(route(`    ssh_pass "user@host" {\n    }`), ["/proxy/route/ssh_pass"], "should reject ssh_pass without a command_pass child", async (payload) => {
  await expect(load(payload)).rejects.toThrow('route /: ssh_pass requiere un command_pass hijo con "curl", "wget" o "node"');
});

testFeature(route(`    kubectl_pass {\n      command_pass curl\n    }`), ["/proxy/route/kubectl_pass"], "should require the destination of kubectl_pass", async (payload) => {
  await expect(load(payload)).rejects.toThrow(
    "route /: kubectl_pass requiere el destino (pod o tipo/nombre, o las subdirectivas pod_name / pod_match)",
  );
});

testFeature(route(`    ssh_pass {\n      command_pass curl\n    }`), ["/proxy/route/ssh_pass"], "should require the destination of ssh_pass", async (payload) => {
  await expect(load(payload)).rejects.toThrow("route /: ssh_pass requiere el destino (usuario@host, o la subdirectiva host)");
});

testFeature(route(`    kubectl_pass {\n      pod_name "a"\n      pod_match "a-*"\n      command_pass curl\n    }`), ["/proxy/route/kubectl_pass"], "should reject pod_name together with pod_match", async (payload) => {
  await expect(load(payload)).rejects.toThrow("route /: pod_name y pod_match no se pueden combinar");
});

testFeature(route(`    kubectl_pass {\n      pod_name "a"\n      command_pass curl\n    }`), ["/proxy/route/kubectl_pass"], "should accept pod_name instead of the target of the line", async (payload) => {
  await accepts(payload);
});

testFeature(route(`    kubectl_pass {\n      pod_match "a-*"\n      command_pass curl\n    }`), ["/proxy/route/kubectl_pass"], "should accept pod_match instead of the target of the line", async (payload) => {
  await accepts(payload);
});

testFeature(route(`    ssh_pass {\n      host "user@host"\n      command_pass curl\n    }`), ["/proxy/route/ssh_pass"], "should accept the host subdirective of ssh_pass", async (payload) => {
  await accepts(payload);
});

testFeature(route(`    ssh_pass "user@host" {\n      port 70000\n      command_pass curl\n    }`), ["/proxy/route/ssh_pass"], "should reject an ssh_pass port out of range", async (payload) => {
  await expect(load(payload)).rejects.toThrow('route /: port debe ser un puerto entre 1 y 65535, no "70000"');
});

testFeature(route(`    ssh_pass "user@host" {\n      user ""\n      command_pass curl\n    }`), ["/proxy/route/ssh_pass"], "should reject an empty ssh_pass user", async (payload) => {
  await expect(load(payload)).rejects.toThrow('route /: user debe ser un nombre, no ""');
});

testFeature(route(`    ssh_pass "user@host" {\n      identity_file 5\n      command_pass curl\n    }`), ["/proxy/route/ssh_pass"], "should reject an ssh_pass identity_file that is not a path", async (payload) => {
  await expect(load(payload)).rejects.toThrow('route /: identity_file debe ser una ruta, no "5"');
});

testFeature(route(`    ssh_pass "user@host" {\n      option ""\n      command_pass curl\n    }`), ["/proxy/route/ssh_pass"], "should reject an empty ssh_pass option", async (payload) => {
  await expect(load(payload)).rejects.toThrow('route /: option debe ser un texto no vacío, p. ej. "StrictHostKeyChecking=accept-new"');
});

testFeature(route(`    ssh_pass "user@host" {\n      pass ""\n      command_pass curl\n    }`), ["/proxy/route/ssh_pass"], "should reject an empty ssh_pass pass", async (payload) => {
  await expect(load(payload)).rejects.toThrow("route /: pass debe ser un texto no vacío");
});

testFeature(route(`    ssh_pass "user@host" {\n      port 2222\n      user deploy\n      identity_file "./id"\n      option "StrictHostKeyChecking=accept-new"\n      pass "secret"\n      command_pass curl\n    }`), ["/proxy/route/ssh_pass"], "should accept every connection setting of ssh_pass", async (payload) => {
  await accepts(payload);
});

testFeature(route(`    ssh_pass "user@host" {\n      command_pass curl {\n        concurrency 0\n      }\n    }`), ["/proxy/route/ssh_pass"], "should reject a concurrency lower than 1 in the child of ssh_pass", async (payload) => {
  await expect(load(payload)).rejects.toThrow('route /: concurrency debe ser un entero positivo, no "0"');
});

testFeature(route(`    proxy_pass "http://example.com/api"`), ["/proxy/route/proxy_pass"], "should accept proxy_pass with a URL", async (payload) => {
  await accepts(payload);
});

testFeature(route(`    respond 204`), ["/proxy/route/respond"], "should accept respond with only a status", async (payload) => {
  await accepts(payload);
});

testFeature(route(`    respond 200 "body"`), ["/proxy/route/respond"], "should accept respond with a status and a body", async (payload) => {
  await accepts(payload);
});

testFeature(`proxy {\n  route /a {\n    respond 200\n  }\n  route POST /b {\n    command_pass curl\n  }\n  route {\n    respond 404\n  }\n}\n`, ["/proxy/route"], "should load routes in the order they are declared", async (payload) => {
  const { routes } = await load(payload);
  expect(routes.map((r) => [r.method, r.action.kind])).toEqual([
    [null, "respond"],
    ["POST", "command_pass"],
    [null, "respond"],
  ]);
});
