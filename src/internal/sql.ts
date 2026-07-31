import { createHash } from "crypto";
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

const SIMPLE_IDENTIFIER = /^[A-Za-z0-9_]+$/;

/**
 * Derives an index-name stem from a table identifier.
 *
 * Flattening every separator to `_` would map `schema.entries` and
 * `schema_entries` onto one name. Because `CREATE INDEX IF NOT EXISTS` is a
 * no-op when the name is taken, the second table would silently end up with no
 * index on `expires_at` and fall back to sequential scans for expiry. Names
 * needing no substitution are returned unchanged, so the common case keeps its
 * readable index name; anything else gets a digest suffix to keep it unique.
 */
export const indexBaseName = (identifier: string): string => {
  if (SIMPLE_IDENTIFIER.test(identifier)) {
    return identifier;
  }
  const digest = createHash("sha256").update(identifier).digest("hex").slice(0, 8);
  return `${identifier.replace(/[^A-Za-z0-9_]/g, "_")}_${digest}`;
};
