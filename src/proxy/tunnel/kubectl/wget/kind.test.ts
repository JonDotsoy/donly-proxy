import { expect } from "bun:test";
import { cluster, echoTest, useKind } from "../kind-fixture";

const kind = useKind("wget");

echoTest("wget", kind);

cluster("[command_pass.kubectl.kind] wget answers GET requests and reports the status of failed ones", async () => {
  const get = await fetch(kind.url("get"), { proxy: kind.proxy() });
  expect(get.status).toBe(200);
  expect((await get.json()).method).toBe("GET");
  const put = await fetch(kind.url("put"), { proxy: kind.proxy(), method: "PUT", body: "x" });
  expect(put.status).toBe(502);
  expect(await put.text()).toContain("wget only supports GET and POST");
}, 60_000);
