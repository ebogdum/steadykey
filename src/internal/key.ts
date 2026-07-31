import { IdempotencyError } from "../errors.js";

export const DEFAULT_MAX_KEY_LENGTH = 512;

/** Matches anything outside printable ASCII, i.e. control characters, space, DEL, and non-ASCII. */
const UNSAFE_CHAR = /[^\x21-\x7E]/u;

/**
 * Anything outside printable non-space ASCII, plus the two characters that
 * carry structural meaning inside a composed store key: `%` (the escape
 * character itself) and `:` (the segment delimiter).
 */
const UNSAFE_SEGMENT_CHAR = /[^\x21-\x7E]|[%:]/gu;

const percentEncode = (char: string): string => {
  let encoded = "";
  for (const byte of Buffer.from(char, "utf8")) {
    encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
};

/**
 * Escapes a single key segment so that composing `prefix:namespace:id` is
 * unambiguous and the result is safe for whitespace-sensitive wire protocols
 * such as the Memcached text protocol.
 *
 * The encoding is prefix-free (`%` is always escaped, as `%25`), so it is
 * injective: two distinct segments can never encode to the same string, and two
 * distinct (namespace, id) pairs can never compose to the same key.
 */
export const encodeKeySegment = (segment: string): string => segment.replace(UNSAFE_SEGMENT_CHAR, percentEncode);

export const assertKeyLength = (label: string, segment: string, maxLength: number): void => {
  if (segment.length > maxLength) {
    throw new IdempotencyError(
      `${label} exceeds the maximum length of ${maxLength} characters (received ${segment.length})`,
    );
  }
};

export const resolveMaxKeyLength = (maxKeyLength: number | undefined): number => {
  if (maxKeyLength === undefined) {
    return DEFAULT_MAX_KEY_LENGTH;
  }
  if (!Number.isInteger(maxKeyLength) || maxKeyLength < 1) {
    throw new IdempotencyError("maxKeyLength must be a positive integer when provided");
  }
  return maxKeyLength;
};

/**
 * Validates a developer-supplied key prefix. Unlike a segment, a prefix may
 * contain `:` (it is commonly used to scope an application), but it must never
 * contain control characters or whitespace.
 */
export const assertSafeKeyPrefix = (keyPrefix: string): void => {
  if (UNSAFE_CHAR.test(keyPrefix)) {
    throw new IdempotencyError("keyPrefix must contain only printable, non-whitespace ASCII characters");
  }
};

/** Rejects a raw store key that a backend cannot persist faithfully. */
export const assertStorableKey = (key: string, maxBytes: number, storeName: string): void => {
  const byteLength = Buffer.byteLength(key, "utf8");
  if (byteLength > maxBytes) {
    throw new IdempotencyError(
      `Key exceeds the ${maxBytes}-byte limit of the ${storeName} store (received ${byteLength} bytes)`,
    );
  }
  if (UNSAFE_CHAR.test(key)) {
    throw new IdempotencyError(
      `Key contains characters outside printable non-whitespace ASCII, which the ${storeName} store cannot store safely`,
    );
  }
};
