import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

// End-to-end test of the `--ui` dashboard: runs the BUILT binary (dist/donly-proxy.js) with a
// real manifest, sends real traffic, and checks the page in Chromium against the .ndjson.
// Run it with `bun run e2e` (see docs/e2e.md). Every port is assigned by the system.
const bundle = resolve(import.meta.dir, "../dist/donly-proxy.js");
const dir = mkdtempSync(join(tmpdir(), "donly-proxy-e2e-"));
const bin = join(dir, "bin");
const logFile = join(dir, "proxy.ndjson");

// Fake kubectl: runs what follows `--` locally, as `kubectl exec` would inside the container.
mkdirSync(bin);
writeFileSync(join(bin, "kubectl"), `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`);
chmodSync(join(bin, "kubectl"), 0o755);

const longToken = "x".repeat(400);
const upstream = http.createServer((req, res) => {
  res.setHeader("content-type", "text/plain");
  res.setHeader("x-long", longToken);
  res.end(`pong:${req.url}:${longToken}`);
});

const manifest = (upstreamPort: number) => `proxy {
  host "127.0.0.1"
  port 0
  log_file "./proxy.ndjson"
  route http://pass.test/ {
    proxy_pass "http://127.0.0.1:${upstreamPort}"
  }
  route http://127.0.0.1:${upstreamPort}/kube {
    kubectl_pass "pod/api-0" {
      command_pass node
    }
  }
}
`;

type Entry = Record<string, any>;
const readLog = (): Entry[] =>
  readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

const saved = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
let child: ReturnType<typeof Bun.spawn>;
let proxy: string;
let ui: string;
let browser: Browser;
let upstreamPort: number;

/** Resolves with the system-assigned ports once the binary reports them on stdout. */
const startBinary = async () => {
  child = Bun.spawn(["bun", bundle, "manifest.donly", "--ui", "--ui-port", "0"], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, NO_PROXY: "", no_proxy: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  let seen = "";
  for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
    seen += decoder.decode(chunk);
    const p = seen.match(/proxy listening on [\d.]+:(\d+)/);
    const u = seen.match(/ui listening on (http:\/\/[\d.]+:\d+)/);
    if (p && u) {
      proxy = `http://127.0.0.1:${p[1]}`;
      ui = u[1]!;
      return;
    }
  }
  throw new Error(`the binary exited before listening: ${seen}`);
};

beforeAll(async () => {
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  upstreamPort = (upstream.address() as AddressInfo).port;
  writeFileSync(join(dir, "manifest.donly"), manifest(upstreamPort));
  await startBinary();

  // fetch skips the proxy for NO_PROXY hosts (loopback included) when the variable is set.
  process.env.NO_PROXY = process.env.no_proxy = "";

  // Real traffic: two proxy_pass requests and two through kubectl.
  const send = async (url: string, init: RequestInit = {}) => (await fetch(url, { proxy, ...init } as RequestInit)).text();
  await send(`http://pass.test/a?q=${longToken}`);
  await send("http://pass.test/b", { method: "POST", body: "ping" });
  await send(`http://127.0.0.1:${upstreamPort}/kube?one=1`);
  await send(`http://127.0.0.1:${upstreamPort}/kube?two=2`);

  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
}, 60_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await browser?.close();
  child?.kill();
  upstream.close();
  rmSync(dir, { recursive: true, force: true });
});

const open = async (width: number, height = 900): Promise<Page> => {
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  await page.goto(ui);
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "en vivo");
  return page;
};

const settle = async (page: Page, lines: number) =>
  page.waitForFunction((n) => document.querySelectorAll("#rows > .row").length === n, lines);

/** Widest overflow, in px, of the page and of every open detail block. */
const overflow = (page: Page) =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const blocks = [...document.querySelectorAll<HTMLElement>(".detail:not([hidden]), .lane-detail, .tx")];
    const wide = Math.max(0, ...blocks.map((b) => b.getBoundingClientRect().right - vw));
    return { page: document.documentElement.scrollWidth - vw, blocks: wide };
  });

describe("--ui dashboard", () => {
  test("the log has the expected nested transactions", () => {
    const log = readLog();
    const types = (t: string) => log.filter((e) => e.type === t).length;
    expect(types("request")).toBe(4);
    expect(types("proxy_pass_request")).toBe(2);
    expect(types("command_start")).toBe(4); // kubectl + engine, twice
    expect(types("script_start")).toBe(2);
    expect(new Set(log.filter((e) => e.transaction_id).map((e) => e.transaction_id)).size).toBe(4);
  });

  test("list view shows one row per ndjson line, in order", async () => {
    const log = readLog();
    const page = await open(1280);
    await settle(page, log.length);
    const types = await page.$$eval("#rows > .row", (rows) => rows.map((r) => (r as HTMLElement).dataset.type));
    expect(types).toEqual(log.map((e) => e.type));
    expect(await page.locator("#view-list").getAttribute("aria-pressed")).toBe("true");
    await page.context().close();
  });

  test("expanded details match the ndjson exactly", async () => {
    const log = readLog();
    const page = await open(1280);
    await settle(page, log.length);
    await page.click("#toggle");
    const shown = await page.$$eval("#rows > .row .detail pre", (pres) => pres.map((p) => JSON.parse(p.textContent ?? "")));
    expect(shown).toEqual(log);
    await page.context().close();
  });

  test("search and type filter narrow the list", async () => {
    const log = readLog();
    const page = await open(1280);
    await settle(page, log.length);
    await page.selectOption("#kind", "proxy_pass_response");
    const visible = () => page.$$eval("#rows > .row:not([hidden])", (rows) => rows.length);
    expect(await visible()).toBe(log.filter((e) => e.type === "proxy_pass_response").length);
    await page.selectOption("#kind", "");
    await page.fill("#search", "no-such-text-anywhere");
    expect(await visible()).toBe(0);
    await page.context().close();
  });

  test("timeline view draws one card per transaction and one lane per span", async () => {
    const log = readLog();
    const page = await open(1280);
    await settle(page, log.length);
    await page.click("#view-timeline");
    expect(await page.locator("#view-timeline").getAttribute("aria-pressed")).toBe("true");

    const txIds = [...new Set(log.filter((e) => e.transaction_id).map((e) => e.transaction_id))];
    expect(await page.locator("#timeline > .tx").count()).toBe(txIds.length);

    const spansOf = (id: string) =>
      new Set(log.filter((e) => e.transaction_id === id && /_start$|^request$|^proxy_pass_request$/.test(e.type)).map((e) => e.span_id));
    const expected = txIds.reduce((n, id) => n + spansOf(id).size, 0);
    expect(await page.locator("#timeline .lane").count()).toBe(expected);
    expect(await page.locator("#timeline .tx-head .title").allTextContents()).toEqual(
      txIds.map((id) => {
        const r = log.find((e) => e.transaction_id === id && e.type === "request")!;
        return `${r.method} ${r.url}`;
      }),
    );
    // No span is left open: every bar is closed once the responses were logged.
    expect(await page.locator("#timeline .bar.open").count()).toBe(0);
    await page.context().close();
  });

  test("?view=timeline opens the timeline directly and a lane shows its JSON", async () => {
    const log = readLog();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await page.goto(`${ui}/?view=timeline`);
    await page.waitForFunction((n) => document.querySelectorAll("#timeline > .tx").length === n, 4);
    expect(await page.locator("#view-timeline").getAttribute("aria-pressed")).toBe("true");
    await page.locator("#timeline .lane").first().click();
    const shown = JSON.parse((await page.locator("#timeline .lane-detail pre").first().textContent()) ?? "[]");
    const rootSpan = log.find((e) => e.type === "request")!.span_id;
    expect(shown.every((e: Entry) => e.span_id === rootSpan)).toBe(true);
    expect(shown.map((e: Entry) => e.type)).toEqual(["request", "response"]);
    await page.context().close();
  });

  for (const width of [1280, 768, 390]) {
    test(`nothing overflows the width at ${width}px (list and timeline, details expanded)`, async () => {
      const log = readLog();
      const page = await open(width);
      await settle(page, log.length);
      await page.click("#toggle");
      const list = await overflow(page);
      expect(list.page).toBeLessThanOrEqual(0);
      expect(list.blocks).toBeLessThanOrEqual(1);

      await page.click("#view-timeline");
      // Each click re-renders its card, so address lanes by index.
      const lanes = await page.locator("#timeline .lane").count();
      for (let i = 0; i < lanes; i++) await page.locator("#timeline .lane").nth(i).click();
      expect(await page.locator("#timeline .lane-detail").count()).toBe(lanes);
      const result = await overflow(page);
      expect(result.page).toBeLessThanOrEqual(0);
      expect(result.blocks).toBeLessThanOrEqual(1);
      await page.context().close();
    });
  }
});
