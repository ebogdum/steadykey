import * as nodeCrypto from "crypto";
import { createHash } from "crypto";
import { IdempotencySerializationError, IdempotencyError } from "./errors.js";
import type { HashAlgorithm, IdempotencyRecord } from "./types.js";

const STRING_PREFIX = "str:";
const BIGINT_PREFIX = "bigint:";
const BUFFER_PREFIX = "buffer:";
const DATE_PREFIX = "date:";
const MAP_PREFIX = "map:";
const SET_PREFIX = "set:";

const MAX_DEPTH = 256;

/** Largest canonical array-index key; V8 orders these numerically, ahead of all other keys. */
const MAX_ARRAY_INDEX = 4294967294;

export interface SerializeRecordInput {
  readonly record: IdempotencyRecord;
}

/**
 * True when a string cannot be embedded in JSON by simply wrapping it in
 * quotes. `JSON.stringify` escapes control characters, `"`, `\`, and lone
 * surrogates; everything else is emitted verbatim. Valid surrogate pairs are
 * treated as needing the slow path too, which is merely conservative.
 */
const needsEscape = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x22 || code === 0x5c || (code >= 0xd800 && code <= 0xdfff)) {
      return true;
    }
  }
  return false;
};

/**
 * Emits `prefix + value` as a JSON string.
 *
 * The concatenation is deliberately not performed before the scan: joining the
 * two up front forces V8 to flatten the rope, which costs more than the scan
 * itself.
 */
const quote = (prefix: string, value: string): string =>
  needsEscape(value) ? JSON.stringify(prefix + value) : `"${prefix}${value}"`;

const isArrayIndex = (key: string): boolean => {
  const asNumber = +key;
  return Number.isInteger(asNumber) && asNumber >= 0 && asNumber <= MAX_ARRAY_INDEX && String(asNumber) === key;
};

const byNumericValue = (a: string, b: string): number => Number(a) - Number(b);

/**
 * Serializes own enumerable properties, reproducing the property order that
 * `JSON.stringify` would produce for an object whose keys were inserted in
 * code-unit order: canonical array-index keys first, numerically, then the rest
 * by UTF-16 code unit. Reordering these would change every generated key.
 */
const writeObject = (value: Record<string, unknown>, depth: number): string => {
  const keys = Object.keys(value);
  let indexKeys: string[] | null = null;
  const namedKeys: string[] = [];

  for (let position = 0; position < keys.length; position += 1) {
    const key = keys[position];
    if (value[key] === undefined) {
      continue;
    }
    // An array-index key must begin with a digit; that check is far cheaper
    // than the full canonical-form test and rejects almost every real key.
    const firstCode = key.charCodeAt(0);
    if (firstCode >= 48 && firstCode <= 57 && isArrayIndex(key)) {
      (indexKeys ??= []).push(key);
    } else {
      namedKeys.push(key);
    }
  }

  // The default sort compares UTF-16 code units, which is exactly the required
  // order, and avoids a comparator callback per comparison.
  if (namedKeys.length > 1) {
    namedKeys.sort();
  }
  if (indexKeys !== null && indexKeys.length > 1) {
    indexKeys.sort(byNumericValue);
  }

  let out = "{";
  let first = true;
  if (indexKeys !== null) {
    for (let position = 0; position < indexKeys.length; position += 1) {
      const key = indexKeys[position];
      out += first ? `"${key}":` : `,"${key}":`;
      first = false;
      out += writeValue(value[key], depth + 1);
    }
  }
  for (let position = 0; position < namedKeys.length; position += 1) {
    const key = namedKeys[position];
    if (!first) {
      out += ",";
    }
    first = false;
    out += `${quote("", key)}:${writeValue(value[key], depth + 1)}`;
  }
  return `${out}}`;
};

/**
 * Writes the canonical JSON text for a value directly, in a single pass.
 *
 * Cases are ordered by how often they occur in a JSON-shaped payload, and a
 * plain object is recognised by its constructor so that the exotic-type probes
 * are skipped entirely for the common case.
 */
const writeValue = (value: unknown, depth: number): string => {
  if (depth > MAX_DEPTH) {
    throw new IdempotencySerializationError(`Payload nesting exceeds the maximum depth of ${MAX_DEPTH}`);
  }

  const type = typeof value;

  if (type === "string") {
    return quote(STRING_PREFIX, value as string);
  }
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new IdempotencySerializationError(`Non-finite number cannot be canonicalized: ${value as number}`);
    }
    return JSON.stringify(value);
  }
  if (type === "boolean") {
    return value ? "true" : "false";
  }
  if (value === null) {
    return "null";
  }

  if (type === "object") {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return "[]";
      }
      let out = "[";
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) {
          out += ",";
        }
        out += writeValue(value[index], depth + 1);
      }
      return `${out}]`;
    }

    const constructor = (value as { constructor?: unknown }).constructor;
    if (constructor === Object || constructor === undefined) {
      return writeObject(value as Record<string, unknown>, depth);
    }

    if (value instanceof Date) {
      return quote(DATE_PREFIX, value.toISOString());
    }
    if (Buffer.isBuffer(value)) {
      return quote(BUFFER_PREFIX, value.toString("base64"));
    }

    if (value instanceof Map) {
      const entries: [string, string][] = [];
      for (const [entryKey, entryValue] of value) {
        entries.push([writeValue(entryKey, depth + 1), writeValue(entryValue, depth + 1)]);
      }
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      let inner = "[";
      for (let index = 0; index < entries.length; index += 1) {
        if (index > 0) {
          inner += ",";
        }
        inner += `[${quote("", entries[index][0])},${entries[index][1]}]`;
      }
      return quote(MAP_PREFIX, `${inner}]`);
    }

    if (value instanceof Set) {
      const entries: string[] = [];
      for (const entry of value) {
        entries.push(writeValue(entry, depth + 1));
      }
      entries.sort();
      let inner = "[";
      for (let index = 0; index < entries.length; index += 1) {
        if (index > 0) {
          inner += ",";
        }
        inner += quote("", entries[index]);
      }
      return quote(SET_PREFIX, `${inner}]`);
    }

    // Any other object — a class instance, an object from another realm — is
    // canonicalized as a plain record.
    return writeObject(value as Record<string, unknown>, depth);
  }

  if (type === "bigint") {
    return quote(BIGINT_PREFIX, (value as bigint).toString(10));
  }

  throw new IdempotencySerializationError(`Unsupported value type: ${type}`);
};

export const canonicalize = (value: unknown): string => {
  try {
    return writeValue(value, 0);
  } catch (error) {
    throw new IdempotencySerializationError(
      error instanceof Error ? error.message : "Failed to canonicalize payload",
    );
  }
};

type OneShotHash = (algorithm: string, data: string, outputEncoding: "hex") => string;

/**
 * Node 20.12+ / 21.7+ provides a one-shot hash that skips allocating and
 * driving a streaming Hash object — roughly twice as fast for a single input
 * this size. Older runtimes (the package supports Node >= 18) use `createHash`.
 */
const oneShotHash: OneShotHash | undefined =
  typeof (nodeCrypto as { hash?: unknown }).hash === "function"
    ? (nodeCrypto as unknown as { hash: OneShotHash }).hash
    : undefined;

export const hashCanonicalValue = (canonicalValue: string, algorithm: HashAlgorithm): string =>
  oneShotHash
    ? oneShotHash(algorithm, canonicalValue, "hex")
    : createHash(algorithm).update(canonicalValue).digest("hex");

export const serializeRecord = ({ record }: SerializeRecordInput): string => {
  try {
    return JSON.stringify(record);
  } catch (error) {
    throw new IdempotencySerializationError(
      error instanceof Error ? error.message : "Failed to serialize idempotency record",
    );
  }
};

export const deserializeRecord = (value: string): IdempotencyRecord => {
  try {
    const parsed = JSON.parse(value) as IdempotencyRecord;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.id !== "string" ||
      typeof parsed.payloadHash !== "string"
    ) {
      throw new IdempotencyError("Stored idempotency record has invalid shape");
    }
    return parsed;
  } catch (error) {
    if (error instanceof IdempotencyError) {
      throw error;
    }
    throw new IdempotencySerializationError(
      error instanceof Error ? error.message : "Failed to deserialize idempotency record",
    );
  }
};
