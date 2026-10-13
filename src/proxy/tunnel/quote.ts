/** Quotes a value as a single shell word; request data never reaches a shell unquoted. */
export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
