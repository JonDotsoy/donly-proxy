import { DON, Directive } from "donly";

export interface FeaturesListing {
  /** The payload with every line of a matched directive marked with `marker` (the rest are indented). */
  features: string;
  message: string;
}

const unmatched = "  ";

/** Default prefix of the marked lines. */
export const MATCHED = "+ ";

/** Last line of the block opened right after (`line`, `column`), or `line` when no block opens there. */
const blockEnd = (lines: string[], line: number, column: number) => {
  let depth = 0;
  for (let l = line; l < lines.length; l++) {
    const text = lines[l]!;
    for (let c = l === line ? column : 0; c < text.length; c++) {
      const char = text[c]!;
      if (char === "#") break;
      if (char === '"') {
        for (c++; c < text.length && text[c] !== '"'; c++) if (text[c] === "\\") c++;
      } else if (char === "{") {
        depth++;
      } else if (char === "}") {
        if (--depth === 0) return l;
      } else if (depth === 0 && char.trim() !== "") {
        return line;
      }
    }
  }
  return line;
};

/**
 * Lists the features of a donly payload: marks the lines of the directives
 * that match any of the `paths` (see `findAllDirectives` in `donly` for the
 * path syntax) with `marker`. A directive with a block is marked from its first line to
 * the closing brace, children included.
 */
export const listFeatures = (
  payload: string,
  paths: string[],
  message: string,
  marker = MATCHED,
): FeaturesListing => {
  const root = DON.parse(payload);
  const source = payload.split("\n");
  const marked = new Set<number>();
  for (const path of paths) {
    for (const directive of root.findAll(path)) {
      const tokens = Directive.tokensByDirective(directive) ?? [];
      if (tokens.length === 0) continue;
      const first = tokens[0]!.span.startLocation;
      const last = tokens[tokens.length - 1]!.span.endLocation;
      const end = blockEnd(source, last.line, last.column);
      for (let line = first.line; line <= end; line++) marked.add(line);
    }
  }
  const features = source
    .map((text, line) => (text === "" ? text : `${marked.has(line) ? marker : unmatched}${text}`))
    .join("\n");
  return { features, message };
};
