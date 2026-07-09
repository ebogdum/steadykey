import { IdempotencyError } from "../errors.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)*$/;

export type IdentifierQuote = '"' | "`";

export const quoteIdentifier = (identifier: string, quote: IdentifierQuote): string => {
  if (!IDENTIFIER.test(identifier)) {
    throw new IdempotencyError(`Invalid identifier provided: ${identifier}`);
  }
  return identifier
    .split(".")
    .map((segment) => `${quote}${segment.split(quote).join(quote + quote)}${quote}`)
    .join(".");
};

export const indexBaseName = (identifier: string): string => identifier.replace(/[^A-Za-z0-9_]/g, "_");
