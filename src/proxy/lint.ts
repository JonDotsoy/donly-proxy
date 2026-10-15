import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { lint, renderReport } from "donly/lint";
import type { LintIssue, LintRuleDocument } from "donly/lint";
import type { Directive } from "donly";
import { isRouteMethod, routeMethods } from "./route-methods";

const actions = ["respond", "proxy_pass", "command_pass", "kubectl_pass", "ssh_pass"];
const proxyDirectives = ["listen", "host", "port", "ssl", "log_file", "route"];
const routeDirectives = actions;

const unknownChildren = (known: string[], where: string) => (directive: Directive): LintIssue[] =>
  directive.children
    .filter((child) => !known.includes(child.name))
    .map((child) => ({
      severity: "warning" as const,
      message: `directiva desconocida \`${child.name}\` en ${where}`
    }));

const deprecated = (name: string) => (): LintIssue[] => [
  { severity: "warning", message: `\`${name}\` está deprecada y se eliminará en una versión futura: usa \`listen\`` },
];

// A `route` with no arguments matches everything: whatever follows it is unreachable.
const unreachableRoutes = (directive: Directive): LintIssue[] => {
  const routes = directive.children.filter((child) => child.name === "route");
  const catchAll = routes.findIndex((route) => route.args.length === 0);
  return catchAll === -1
    ? []
    : routes.slice(catchAll + 1).map((route) => ({
        severity: "warning" as const,
        message: "ruta inalcanzable: va después de una `route` sin argumentos, que coincide con todo"
      }));
};

// `route [MÉTODO] <patrón>`: one argument validates only the URL, two validate the method and the URL.
const routeArguments = (directive: Directive): LintIssue[] => {
  const { args } = directive;
  const name = args.length === 0 ? "route" : `route ${args.join(" ")}`;
  if (args.length > 2) {
    return [{ severity: "error", message: `${name}: route recibe un patrón o un método y un patrón, hay ${args.length} argumentos` }];
  }
  const issues: LintIssue[] = [];
  const [method] = args.length === 2 ? args : [];
  if (method !== undefined && !isRouteMethod(method)) {
    issues.push({ severity: "error", message: `${name}: el método debe ser uno de ${routeMethods.join(", ")}, no "${method}"` });
  }
  const pattern = args[args.length - 1];
  if (pattern !== undefined && typeof pattern !== "string") {
    issues.push({ severity: "error", message: `${name}: el patrón debe ser un texto, no "${pattern}"` });
  }
  return issues;
};

const routeActions = (directive: Directive): LintIssue[] => {
  const found = directive.children.filter((child) => routeDirectives.includes(child.name)).map((child) => child.name);
  if (found.length === 1) return [];
  const name = directive.args.length === 0 ? "route" : `route ${directive.args.join(" ")}`;
  return [{
    severity: "error",
    message: `${name}: se requiere exactamente una acción (${actions.join(", ")}), hay ${found.length}${found.length > 0 ? ` (${found.join(", ")})` : ""}`,
  }];
};

/** Lint rules for `manifest.donly`, in the `donly/lint` rule-document format. */
export const manifestRules: LintRuleDocument = {
  "/proxy": {
    required: true,
    message: "el manifiesto requiere un bloque `proxy`",
    evaluation: (directive) => [...unknownChildren(proxyDirectives, "proxy")(directive), ...unreachableRoutes(directive)],
  },
  "/proxy/host": { evaluation: deprecated("host") },
  "/proxy/host[1]": { type: "string", message: "host debe ser un texto" },
  "/proxy/port": { evaluation: deprecated("port") },
  "/proxy/port[1]": {
    type: "number",
    gte: 0,
    lte: 65535,
    message: "port debe ser un número entre 0 y 65535",
  },
  "/proxy/log_file[1]": {
    type: "string",
    pattern: "\\.ndjson$",
    message: "log_file solo soporta la extensión .ndjson",
  },
  "/proxy/ssl": { evaluation: unknownChildren(["cert", "key"], "ssl") },
  "/proxy/ssl/cert[1]": { type: "string", message: "ssl.cert debe ser un texto" },
  "/proxy/ssl/key[1]": { type: "string", message: "ssl.key debe ser un texto" },
  "/proxy/route": { evaluation: (directive) => [...routeArguments(directive), ...routeActions(directive), ...unknownChildren(routeDirectives, "route")(directive)] },
  // The body is optional, so it is checked here instead of with a `[2]` constraint.
  "/proxy/route/respond": {
    evaluation: (directive) => {
      const [, body, ...extra] = directive.args;
      const issues: LintIssue[] = [];
      if (body !== undefined && typeof body !== "string") {
        issues.push({ severity: "error", message: "el cuerpo de respond debe ser un texto entre comillas" });
      }
      if (extra.length > 0) issues.push({ severity: "warning", message: "respond recibe estado y cuerpo; sobran argumentos" });
      return issues;
    },
  },
  "/proxy/route/respond[1]": {
    type: "number",
    gte: 100,
    lte: 599,
    message: "respond requiere un estado HTTP entre 100 y 599",
  },
  "/proxy/route/proxy_pass[1]": { type: "string", pattern: "^https?://", message: "proxy_pass requiere una URL http(s)" },
};

/** Lints the manifest source with {@link manifestRules}. */
export const lintManifest = (source: string): LintIssue[] => lint(source, manifestRules);

/**
 * Lints the manifest at `manifest`, printing the report when there is anything to say.
 * Returns `false` when it has errors (warnings never block).
 */
export const lintManifestFile = async (
  manifest: string | URL,
  log: (text: string) => void = console.error,
): Promise<boolean> => {
  const url = typeof manifest === "string" ? pathToFileURL(manifest) : manifest;
  const issues = lintManifest(await readFile(url, "utf8"));
  if (issues.length > 0) {
    log(renderReport(issues, { filePath: typeof manifest === "string" ? manifest : manifest.pathname, asciiColor: process.stderr.isTTY ?? false }));
  }
  return !issues.some((issue) => issue.severity === "error");
};
