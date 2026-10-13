import { DON, Directive } from "donly";

export interface FeaturesListing {
  /** The payload with every line of a matched directive marked with `++` (the rest are indented). */
  features: string;
  message: string;
}

const matched = "++";
const unmatched = "  ";

/**
 * Lists the features of a donly payload: marks the lines of the directives
 * that match any of the `paths` (see `findAllDirectives` in `donly` for the
 * path syntax). Only the directive itself (name and arguments) is marked,
 * not its children.
 */
export const listFeatures = (
  payload: string,
  paths: string[],
  message: string,
): FeaturesListing => {
  const root = DON.parse(payload);
  const lines = new Set<number>();
  for (const path of paths) {
    for (const directive of root.findAll(path)) {
      for (const token of Directive.tokensByDirective(directive) ?? []) {
        for (let line = token.span.startLocation.line; line <= token.span.endLocation.line; line++) {
          lines.add(line);
        }
      }
    }
  }
  const features = payload
    .split("\n")
    .map((text, line) => (text === "" ? text : `${lines.has(line) ? matched : unmatched}${text}`))
    .join("\n");
  return { features, message };
};
