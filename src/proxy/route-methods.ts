import { METHODS } from "node:http";

/** Methods a `route` can name. `CONNECT` is left out: it opens a tunnel and is never routed. */
export const routeMethods: readonly string[] = METHODS.filter((method) => method !== "CONNECT");

export const isRouteMethod = (method: unknown): method is string =>
  typeof method === "string" && routeMethods.includes(method.toUpperCase());
