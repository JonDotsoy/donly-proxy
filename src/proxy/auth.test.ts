import { afterAll, beforeAll, expect } from "bun:test";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServers, loadConfig } from "./server";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-auth-"));
const seen: http.IncomingHttpHeaders[] = [];
const upstream = http.createServer((req, res) => {
  seen.push(req.headers);
  res.end("from upstream");
});

const manifestPayload = (port: number) => `proxy {
  listen http 127.0.0.1 0
  listen socks5 127.0.0.1 0
  listen https 127.0.0.1 0
  log_file "./auth.ndjson"
  auth basic {
    username "alice"
    password "s3cr3t pass"
  }
  auth basic {
    username "bob"
    password "other"
  }
  route http://upstream.test/* {
    proxy_pass http://127.0.0.1:${port}/
  }
  route https://secure.test/* {
    respond 200 "secure good"
  }
  route http://plain.test/* {
    respond 200 "plain good"
  }
}
`;

let servers: net.Server[];
let ports: { http: number; socks: number; https: number };
let noProxy: [string | undefined, string | undefined];

beforeAll(async () => {
  noProxy = [process.env.NO_PROXY, process.env.no_proxy];
  process.env.NO_PROXY = process.env.no_proxy = "";
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const file = join(dir, "manifest.donly");
  writeFileSync(file, manifestPayload((upstream.address() as AddressInfo).port));
  const config = await loadConfig(file);
  servers = createProxyServers(config);
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve))));
  const [h, s, t] = servers.map((s) => (s.address() as AddressInfo).port);
  ports = { http: h!, socks: s!, https: t! };
});

afterAll(() => {
  for (const s of servers) s.close();
  upstream.close();
  if (noProxy[0] === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = noProxy[0];
  if (noProxy[1] === undefined) delete process.env.no_proxy;
  else process.env.no_proxy = noProxy[1];
});

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const get = (url: string, authorization?: string) =>
  fetch(url, { proxy: `http://127.0.0.1:${ports.http}`, headers: authorization ? { "proxy-authorization": authorization } : {} });

const curl = async (...args: string[]) => {
  const proc = Bun.spawn(["curl", "-sS", "-k", "--max-time", "4", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { out, err, code: await proc.exited };
};

const raw = (port: number, bytes: number[]) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, "127.0.0.1", () => socket.write(Buffer.from(bytes)));
    socket.on("data", (c) => chunks.push(c));
    socket.on("error", () => {});
    socket.on("close", () => resolve(Buffer.concat(chunks)));
    setTimeout(() => socket.destroy(), 1000);
  });

const logLines = () =>
  readFileSync(join(dir, "auth.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const payload = manifestPayload(0);

testFeature(payload, ["/proxy/auth"], "should answer 407 with Proxy-Authenticate when the proxy-authorization header is missing", async () => {
  const res = await get("http://plain.test/");
  expect(res.status).toBe(407);
  expect(res.headers.get("proxy-authenticate")).toBe('Basic realm="donly-proxy", charset="UTF-8"');
});

testFeature(payload, ["/proxy/auth/password"], "should answer 407 when the password is wrong", async () => {
  expect((await get("http://plain.test/", basic("alice", "nope"))).status).toBe(407);
  expect((await get("http://plain.test/", basic("nobody", "s3cr3t pass"))).status).toBe(407);
  expect((await get("http://plain.test/", "Bearer abc")).status).toBe(407);
  expect((await get("http://plain.test/", "Basic !!!")).status).toBe(407);
});

testFeature(payload, ["/proxy/auth/username", "/proxy/auth/password"], "should accept every user declared by a repeated auth basic", async () => {
  for (const [user, pass] of [["alice", "s3cr3t pass"], ["bob", "other"]] as const) {
    const res = await get("http://plain.test/", basic(user, pass));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("plain good");
  }
  expect((await get("http://plain.test/", basic("bob", "s3cr3t pass"))).status).toBe(407);
});

testFeature(payload, ["/proxy/auth", "/proxy/route/proxy_pass"], "should not forward proxy-authorization to the proxy_pass target", async () => {
  seen.length = 0;
  const res = await get("http://upstream.test/", basic("alice", "s3cr3t pass"));
  expect(await res.text()).toBe("from upstream");
  expect(seen).toHaveLength(1);
  expect(seen[0]!["proxy-authorization"]).toBeUndefined();
});

testFeature(payload, ["/proxy/auth"], "should refuse the CONNECT with 407 without valid credentials and tunnel with them", async () => {
  const proxy = `http://127.0.0.1:${ports.http}`;
  const denied = await curl("-o", "/dev/null", "-w", "%{http_connect}", "--proxy", proxy, "https://secure.test/");
  expect(denied.out).toBe("407");
  const wrong = await curl("-o", "/dev/null", "-w", "%{http_connect}", "--proxy", proxy, "--proxy-user", "alice:wrong", "https://secure.test/");
  expect(wrong.out).toBe("407");
  const ok = await curl("--proxy", proxy, "--proxy-user", "alice:s3cr3t pass", "https://secure.test/");
  expect(ok.err).toBe("");
  expect(ok.out).toBe("secure good");
});

testFeature(payload, ["/proxy/auth", "/proxy/listen"], "should authenticate through a https listener", async () => {
  const res = await curl("--proxy", `https://127.0.0.1:${ports.https}`, "--proxy-insecure", "--proxy-user", "bob:other", "http://plain.test/");
  expect(res.err).toBe("");
  expect(res.out).toBe("plain good");
  const denied = await curl("-o", "/dev/null", "-w", "%{http_code}", "--proxy", `https://127.0.0.1:${ports.https}`, "--proxy-insecure", "http://plain.test/");
  expect(denied.out).toBe("407");
});

testFeature(payload, ["/proxy/auth", "/proxy/listen"], "should authenticate a socks5 client with username and password", async () => {
  const proxy = `127.0.0.1:${ports.socks}`;
  const ok = await curl("--socks5-hostname", proxy, "--proxy-user", "alice:s3cr3t pass", "https://secure.test/");
  expect(ok.err).toBe("");
  expect(ok.out).toBe("secure good");
  const inline = await curl("--socks5-hostname", `bob:other@${proxy}`, "http://plain.test/");
  expect(inline.out).toBe("plain good");
  const wrong = await curl("--socks5-hostname", proxy, "--proxy-user", "alice:wrong", "https://secure.test/");
  expect(wrong.code).not.toBe(0);
  expect(wrong.out).toBe("");
  const none = await curl("--socks5-hostname", proxy, "https://secure.test/");
  expect(none.code).not.toBe(0);
});

testFeature(payload, ["/proxy/auth", "/proxy/listen"], "should answer the socks5 username/password subnegotiation status", async () => {
  const user = [...Buffer.from("alice")];
  const pass = [...Buffer.from("s3cr3t pass")];
  const good = await raw(ports.socks, [5, 1, 2, 1, user.length, ...user, pass.length, ...pass]);
  expect([...good.subarray(0, 4)]).toEqual([5, 2, 1, 0]);
  const bad = await raw(ports.socks, [5, 1, 2, 1, user.length, ...user, 1, 120]);
  expect([...bad]).toEqual([5, 2, 1, 1]);
  const noAuth = await raw(ports.socks, [5, 1, 0]);
  expect([...noAuth]).toEqual([5, 0xff]);
});

testFeature(payload, ["/proxy/auth", "/proxy/log_file"], "should never write the password to the log and should record the user and the failures", async () => {
  await get("http://plain.test/?logged", basic("alice", "s3cr3t pass"));
  await get("http://plain.test/?denied", basic("alice", "bad-password-xyz"));
  await curl("-o", "/dev/null", "--proxy", `http://127.0.0.1:${ports.http}`, "--proxy-user", "mallory:bad-connect-xyz", "https://secure.test/");
  await Bun.sleep(50);
  const text = readFileSync(join(dir, "auth.ndjson"), "utf8");
  for (const secret of ["s3cr3t pass", "bad-password-xyz", "bad-connect-xyz", Buffer.from("alice:s3cr3t pass").toString("base64"), Buffer.from("alice:bad-password-xyz").toString("base64")]) {
    expect(text).not.toContain(secret);
  }
  const lines = logLines();
  expect(lines.find((l) => l.type === "request" && l.url === "http://plain.test/?logged")).toMatchObject({ proxy_user: "alice" });
  expect(lines.find((l) => l.type === "request" && l.url === "http://plain.test/?denied")?.headers["proxy-authorization"]).toBe("[redacted]");
  expect(lines.find((l) => l.type === "auth_failed" && l.protocol === "connect" && l.user === "mallory")).toMatchObject({ scheme: "basic", user: "mallory" });
});

const bad = (body: string, ...listen: string[]) => `proxy {\n  ${listen.join("\n  ") || "listen http 0"}\n${body}\n}\n`;
const reject = async (source: string, message: string) => {
  const file = join(dir, `bad-${Math.random().toString(36).slice(2)}.donly`);
  writeFileSync(file, source);
  await expect(loadConfig(file)).rejects.toThrow(message);
};

const unknown = bad(`  auth digest {\n    username "a"\n    password "b"\n  }`);
testFeature(unknown, ["/proxy/auth"], "should reject an auth scheme other than basic", () => reject(unknown, "auth: solo se soporta basic"));

const noPassword = bad(`  auth basic {\n    username "a"\n  }`);
testFeature(noPassword, ["/proxy/auth/username"], "should reject an auth basic without password", () => reject(noPassword, "auth basic: username y password son obligatorios"));

const noUser = bad(`  auth basic {\n    password "b"\n  }`);
testFeature(noUser, ["/proxy/auth/password"], "should reject an auth basic without username", () => reject(noUser, "auth basic: username y password son obligatorios"));

const dup = bad(`  auth basic {\n    username "a"\n    password "b"\n  }\n  auth basic {\n    username "a"\n    password "c"\n  }`);
testFeature(dup, ["/proxy/auth"], "should reject a repeated username", () => reject(dup, 'auth basic: el usuario "a" está declarado más de una vez'));

const colon = bad(`  auth basic {\n    username "a:b"\n    password "c"\n  }`);
testFeature(colon, ["/proxy/auth/username"], "should reject a username with a colon", () => reject(colon, "username no puede contener ':'"));

const socks4 = bad(`  auth basic {\n    username "a"\n    password "b"\n  }`, "listen socks4 0");
testFeature(socks4, ["/proxy/auth", "/proxy/listen"], "should reject auth together with a socks4 listener", () => reject(socks4, "socks4 no soporta autenticación"));
