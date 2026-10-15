import { expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintManifest } from "./lint";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-lint-"));
const messages = (payload: string, severity?: string) =>
  lintManifest(payload)
    .filter((issue) => severity === undefined || issue.severity === severity)
    .map((issue) => issue.message);

const valid = `proxy {
  log_file "./logs/proxy.ndjson"
  ssl {
    cert "./certs/cert.pem"
    key "./certs/key.pem"
  }
  route https?://example.com/ {
    respond 200 "good"
  }
  route {
    respond 404
  }
}
`;

testFeature(valid, ["/proxy"], "should lint a valid manifest without issues", (payload) => {
  expect(lintManifest(payload)).toEqual([]);
});

testFeature(`route {\n  respond 200 "ok"\n}\n`, ["/proxy"], "should report an error when the manifest has no proxy block", (payload) => {
  expect(messages(payload, "error")).toEqual(["el manifiesto requiere un bloque `proxy`"]);
});

testFeature(`proxy {\n  port 70000\n}\n`, ["/proxy/port"], "should report an error when the port is out of range", (payload) => {
  expect(messages(payload, "error")).toEqual(["port debe ser un número entre 0 y 65535"]);
});

testFeature(`proxy {\n  port "8080"\n}\n`, ["/proxy/port"], "should report an error when the port is not a number", (payload) => {
  expect(messages(payload, "error")).toEqual(["port debe ser un número entre 0 y 65535"]);
});

testFeature(`proxy {\n  host 127\n}\n`, ["/proxy/host"], "should report an error when the host is not a string", (payload) => {
  expect(messages(payload, "error")).toEqual(["host debe ser un texto"]);
});

testFeature(`proxy {\n  log_file "./proxy.log"\n}\n`, ["/proxy/log_file"], "should report an error when log_file is not .ndjson", (payload) => {
  expect(messages(payload, "error")).toEqual(["log_file solo soporta la extensión .ndjson"]);
});

testFeature(`proxy {\n  ssl {\n    cert 1\n    key 2\n  }\n}\n`, ["/proxy/ssl"], "should report an error when ssl cert or key is not a string", (payload) => {
  expect(messages(payload, "error")).toEqual(["ssl.cert debe ser un texto", "ssl.key debe ser un texto"]);
});

testFeature(`proxy {\n  route a {\n  }\n  route b {\n    respond 200\n    proxy_pass "http://x/"\n  }\n}\n`, ["/proxy/route"], "should report an error when a route has not exactly one action", (payload) => {
  expect(messages(payload, "error")).toEqual([
    "route a: se requiere exactamente una acción (respond, proxy_pass, command_pass, kubectl_pass, ssh_pass), hay 0",
    "route b: se requiere exactamente una acción (respond, proxy_pass, command_pass, kubectl_pass, ssh_pass), hay 2 (respond, proxy_pass)",
  ]);
});

testFeature(`proxy {\n  route a {\n    respond 700 "x"\n  }\n  route b {\n    respond 200 5\n  }\n}\n`, ["/proxy/route/respond"], "should report errors for an invalid respond status or body", (payload) => {
  expect(messages(payload, "error").sort()).toEqual([
    "el cuerpo de respond debe ser un texto entre comillas",
    "respond requiere un estado HTTP entre 100 y 599",
  ]);
});

testFeature(`proxy {\n  route a {\n    proxy_pass "ftp://x/"\n  }\n}\n`, ["/proxy/route/proxy_pass"], "should report an error when proxy_pass is not an http url", (payload) => {
  expect(messages(payload, "error")).toEqual(["proxy_pass requiere una URL http(s)"]);
});

testFeature(`proxy {\n  tls {\n  }\n  route a {\n    respond 200\n    timeout 5\n  }\n}\n`, ["/proxy"], "should only warn about unknown directives", (payload) => {
  expect(messages(payload, "error")).toEqual([]);
  expect(messages(payload, "warning")).toEqual(["directiva desconocida `tls` en proxy", "directiva desconocida `timeout` en route"]);
});

testFeature(`proxy {\n  route {\n    respond 404\n  }\n  route a {\n    respond 200\n  }\n}\n`, ["/proxy/route()"], "should warn about routes declared after a route without arguments", (payload) => {
  expect(messages(payload, "error")).toEqual([]);
  expect(messages(payload, "warning")).toEqual(["ruta inalcanzable: va después de una `route` sin argumentos, que coincide con todo"]);
});

testFeature(`proxy {\n  route {\n    kubectl_pass {}\n    proxy_pass {}\n  }\n}\n`, ["/proxy/route/kubectl_pass", "/proxy/route/proxy_pass"], "should report an error when a route mixes two passes", (payload) => {
  expect(messages(payload, "error")).toContain(
    "route: se requiere exactamente una acción (respond, proxy_pass, command_pass, kubectl_pass, ssh_pass), hay 2 (kubectl_pass, proxy_pass)",
  );
});

testFeature(`proxy {\n  host "127.0.0.1"\n  port 8080\n}\n`, ["/proxy/host", "/proxy/port"], "should warn that host and port are deprecated", (payload) => {
  expect(messages(payload, "error")).toEqual([]);
  expect(messages(payload, "warning")).toEqual([
    "`host` está deprecada y se eliminará en una versión futura: usa `listen`",
    "`port` está deprecada y se eliminará en una versión futura: usa `listen`",
  ]);
});

testFeature(`proxy {\n  listen http 127.0.0.1 8080\n}\n`, ["/proxy/listen"], "should not warn about listen", (payload) => {
  expect(lintManifest(payload)).toEqual([]);
});

const run = (payload: string) => {
  const file = join(dir, `manifest-${Math.random()}.donly`);
  writeFileSync(file, payload);
  return Bun.spawn(["bun", join(import.meta.dir, "../cli/main.ts"), file], { stdout: "pipe", stderr: "pipe" });
};

testFeature(`proxy {\n  port 70000\n}\n`, ["/proxy/port"], "should abort the start with a non-zero exit code when the lint has errors", async (payload) => {
  const child = run(payload);
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain("port debe ser un número entre 0 y 65535");
});

testFeature(`proxy {\n  tls {\n  }\n  route {\n    respond 200\n  }\n}\n`, ["/proxy"], "should print the warnings and keep starting", async (payload) => {
  const child = run(payload);
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  child.kill();
  expect(new TextDecoder().decode(value)).toContain("proxy listening on 127.0.0.1:");
  expect(await new Response(child.stderr).text()).toContain("directiva desconocida `tls` en proxy");
});
