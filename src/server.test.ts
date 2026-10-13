import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { createProxyServer } from "./server";

const server = createProxyServer();
let proxy: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

test("GET http://example.com through the proxy responds ok", async () => {
  const res = await fetch("http://example.com", { proxy });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

test("GET https://example.com through the proxy responds ok", async () => {
  const res = await fetch("https://example.com", {
    proxy,
    tls: { rejectUnauthorized: false },
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});
