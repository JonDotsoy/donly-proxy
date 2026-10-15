/** What a route needs from its pattern: test the full request URL. A `RegExp` satisfies it. */
export interface RoutePattern {
  test(url: string): boolean;
}

const PREFIX = "urlpattern:";

/**
 * Compiles the `<patrón>` argument of a route. Plain patterns stay JavaScript regular expressions;
 * a pattern starting with `urlpattern:` is a WHATWG `URLPattern`. Without a scheme it is a
 * host-based shorthand: `urlpattern:example.com` becomes `*://example.com/*`.
 */
export const compileRoutePattern = (source: string): RoutePattern => {
  if (!source.startsWith(PREFIX)) return new RegExp(source);
  let body = source.slice(PREFIX.length).trim();
  if (body === "") throw new Error("urlpattern vacío");
  if (!body.includes("://")) body = `*://${body}`;
  // Without a path the pattern would only match "/"; a host-only pattern means "any path".
  const authorityEnd = body.indexOf("://") + 3;
  if (!body.slice(authorityEnd).includes("/")) body += "/*";
  return new URLPattern(body);
};
