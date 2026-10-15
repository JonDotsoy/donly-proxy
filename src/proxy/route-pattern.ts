/** What a route needs from its pattern: test the full request URL. */
export interface RoutePattern {
  test(url: string): boolean;
}

/**
 * Compiles the `<patrón>` argument of a route into a WHATWG `URLPattern`. Without a scheme it is a
 * host-based shorthand: `example.com` becomes `*://example.com/*`. Without a path, `/*` is added.
 */
export const compileRoutePattern = (source: string): RoutePattern => {
  let body = source.trim();
  if (body === "") throw new Error("patrón vacío");
  if (!body.includes("://")) body = `*://${body}`;
  // Without a path the pattern would only match "/"; a host-only pattern means "any path".
  const authorityEnd = body.indexOf("://") + 3;
  if (!body.slice(authorityEnd).includes("/")) body += "/*";
  return new URLPattern(body);
};
