import { expect, test } from "bun:test";
import { listFeatures } from "./list-features";

const payload = `proxy {
  port 3000
}
`;

test("[manifest.features] marks the lines of the directives matching the paths", () => {
  expect(listFeatures(payload, ["/proxy/port"], "<message>")).toEqual({
    features: `  proxy {
++  port 3000
  }
`,
    message: "<message>",
  });
});

test("[manifest.features] marks every matching directive of several paths", () => {
  const manifest = `proxy {
  port 3000
  route GET "a" {
    respond 200 "ok"
  }
}
`;
  expect(listFeatures(manifest, ["/proxy/port", "/proxy/route/respond"], "m").features).toBe(`  proxy {
++  port 3000
    route GET "a" {
++    respond 200 "ok"
    }
  }
`);
});

test("[manifest.features] a block directive marks only its own line", () => {
  expect(listFeatures(`proxy {\n  route {\n    respond 200 "ok"\n  }\n}\n`, ["/proxy/route"], "m").features)
    .toBe(`  proxy {\n++  route {\n      respond 200 "ok"\n    }\n  }\n`);
});

test("[manifest.features] without matches nothing is marked", () => {
  expect(listFeatures(payload, ["/proxy/host"], "m").features).toBe(`  proxy {\n    port 3000\n  }\n`);
});
