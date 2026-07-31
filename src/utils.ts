import { createHash } from "crypto";
import { IdempotencySerializationError, IdempotencyError } from "./errors.js";
import type { HashAlgorithm, IdempotencyRecord } from "./types.js";

const STRING_PREFIX = "str:";
const BIGINT_PREFIX = "bigint:";
const BUFFER_PREFIX = "buffer:";
const DATE_PREFIX = "date:";
const MAP_PREFIX = "map:";
const SET_PREFIX = "set:";

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const MAX_DEPTH = 256;

export type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export interface SerializeRecordInput {
  readonly record: IdempotencyRecord;
}

export const canonicalize = (value: unknown): string => {
  try {
    const normalized = normalize(value, 0);
    return JSON.stringify(normalized);
  } catch (error) {
    throw new IdempotencySerializationError(
      error instanceof Error ? error.message : "Failed to canonicalize payload",
    );
  }
};

const normalize = (value: unknown, depth: number): CanonicalJsonValue => {
  if (depth > MAX_DEPTH) {
    throw new IdempotencySerializationError(`Payload nesting exceeds the maximum depth of ${MAX_DEPTH}`);
  }

  if (value === null) {
    return null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new IdempotencySerializationError(`Non-finite number cannot be canonicalized: ${value}`);
    }
    return value;
  }

  if (typeof value === "string") {
    return `${STRING_PREFIX}${value}`;
  }

  if (typeof value === "bigint") {
    return `${BIGINT_PREFIX}${value.toString(10)}`;
  }

  if (value instanceof Date) {
    return `${DATE_PREFIX}${value.toISOString()}`;
  }

  if (Buffer.isBuffer(value)) {
    return `${BUFFER_PREFIX}${value.toString("base64")}`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalize(item, depth + 1));
  }

  if (value instanceof Map) {
    const entries = Array.from(value.entries())
      .map(
        ([entryKey, entryValue]) =>
          [
            JSON.stringify(normalize(entryKey, depth + 1)),
            normalize(entryValue, depth + 1),
          ] as const,
      )
      .sort(([keyA], [keyB]) => compareCodeUnits(keyA, keyB));
    return `${MAP_PREFIX}${JSON.stringify(entries)}`;
  }

  if (value instanceof Set) {
    const entries = Array.from(value.values())
      .map((entry) => JSON.stringify(normalize(entry, depth + 1)))
      .sort(compareCodeUnits);
    return `${SET_PREFIX}${JSON.stringify(entries)}`;
  }

  if (typeof value === "object") {
    const plain = Object.create(null) as Record<string, CanonicalJsonValue>;
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([keyA], [keyB]) => compareCodeUnits(keyA, keyB));

    for (const [entryKey, entryValue] of entries) {
      plain[entryKey] = normalize(entryValue, depth + 1);
    }

    return plain;
  }

  throw new IdempotencySerializationError(`Unsupported value type: ${typeof value}`);
};

export const hashCanonicalValue = (canonicalValue: string, algorithm: HashAlgorithm): string => {
  return createHash(algorithm).update(canonicalValue).digest("hex");
};

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
    if (typeof parsed !== "object" || parsed === null || typeof parsed.id !== "string") {
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
