import { afterAll, beforeAll, expect } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { aliases, createPlugin, plugins } from "./plugins";
import { testFeature } from "../../utils/test_utils/test-feature/test-feature";

const upstream = http.createServer(async (req, res) => {
  const body = Buffer.concat(await Array.fromAsync(req)).toString();
  res.setHeader("x-upstream", "yes");
  res.end(JSON.stringify({ method: req.method, url: req.url, body }));
});
let port: number;
beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  port = (upstream.address() as AddressInfo).port;
});
afterAll(() => upstream.close());

const payload = `proxy {\n  route / {\n    proxy_pass "http://127.0.0.1:8080/"\n  }\n}\n`;

testFeature(payload, ["/proxy/route/proxy_pass", "/proxy/route/command_pass"], "should install a plugin for every engine and transport", () => {
  expect(Object.keys(plugins).sort()).toEqual(["curl", "kubectl", "node", "proxy", "ssh"]);
});

testFeature(payload, ["/proxy/route/proxy_pass", "/proxy/route/ssh_pass", "/proxy/route/kubectl_pass"], "should resolve the pass directives as aliases of their plugin", () => {
  expect(aliases).toEqual({ proxy_pass: "proxy", ssh_pass: "ssh", kubectl_pass: "kubectl" });
  for (const alias of Object.keys(aliases)) expect(() => createPlugin(alias)).not.toThrow();
});

testFeature(payload, ["/proxy/route/command_pass"], "should reject a plugin name that is not installed", () => {
  expect(() => createPlugin("rsh")).toThrow('command_pass: no hay un plugin llamado "rsh"');
});

testFeature(payload, ["/proxy/route/proxy_pass"], "should give every route its own plugin state", async () => {
  const a = createPlugin("proxy");
  const b = createPlugin("proxy");
  await a.start({ args: [`http://127.0.0.1:${port}/a`] });
  await b.start({ args: [`http://127.0.0.1:${port}/`] });
  const first = await (await a.request(new Request("http://example.test/x"))).json();
  const second = await (await b.request(new Request("http://example.test/x"))).json();
  expect(first.url).toBe("/a");
  expect(second.url).toBe("/x");
});

testFeature(payload, ["/proxy/route/proxy_pass"], "should answer with a plain fetch in the proxy plugin and keep the query", async () => {
  const plugin = createPlugin("proxy_pass");
  await plugin.start({ args: [`http://127.0.0.1:${port}/`] });
  const response = await plugin.request(new Request("http://example.test/p?x=1", { method: "POST", body: "hi" }));
  expect(response.status).toBe(200);
  expect(response.headers.get("x-upstream")).toBe("yes");
  expect(await response.json()).toEqual({ method: "POST", url: "/p?x=1", body: "hi" });
});

testFeature(payload, ["/proxy/route/proxy_pass"], "should report an unreachable upstream as a bad gateway in the proxy plugin", async () => {
  const plugin = createPlugin("proxy");
  await plugin.start({ args: ["http://127.0.0.1:1/"] });
  const response = await plugin.request(new Request("http://example.test/"));
  expect(response.status).toBe(502);
  expect(await response.text()).toStartWith("bad gateway: ");
});
