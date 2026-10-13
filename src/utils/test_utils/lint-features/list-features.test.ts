import { expect, test } from "bun:test";
import { listFeatures } from "./list-features";

const payload = `proxy {
  port 3000
}
`;

const manifest = `proxy {
  port 3000
  route GET "a" {
    respond 200 "ok"
  }
}
`;

test("[manifest.features] marks the lines of the directives matching the paths", () => {
  const { features, message } = listFeatures(payload, ["/proxy/port"], "<message>");
  expect(message).toBe("<message>");
  expect(features).toMatchSnapshot();
});

test("[manifest.features] marks every matching directive of several paths", () => {
  expect(listFeatures(manifest, ["/proxy/port", "/proxy/route/respond"], "m").features).toMatchSnapshot();
});

test("[manifest.features] a block directive is marked up to its closing brace, children included", () => {
  expect(listFeatures(manifest, ["/proxy/route"], "m").features).toMatchSnapshot();
});

test("[manifest.features] without matches nothing is marked", () => {
  expect(listFeatures(payload, ["/proxy/host"], "m").features).toMatchSnapshot();
});

test("[manifest.features] the root block marks the whole payload", () => {
  expect(listFeatures(manifest, ["/proxy"], "m").features).toMatchSnapshot();
});

test("[manifest.features] braces and # inside strings and comments do not end a block", () => {
  const tricky = `proxy {\n  # {\n  route GET "a}" {\n    respond 200 "ok"\n  }\n  port 3000\n}\n`;
  expect(listFeatures(tricky, ["/proxy/route"], "m").features).toMatchSnapshot();
});
