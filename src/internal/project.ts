const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  !(value instanceof Map) &&
  !(value instanceof Set) &&
  !Buffer.isBuffer(value);

const hasOwn = (obj: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Own properties only. Using `in` would report inherited members such as
 * `toString` or `valueOf` as present, so projecting them would pull a function
 * off the prototype chain into the payload being canonicalized.
 */
const hasPath = (obj: unknown, segments: readonly string[]): boolean => {
  let cursor: unknown = obj;
  for (const segment of segments) {
    if (!isRecord(cursor) || !hasOwn(cursor, segment)) {
      return false;
    }
    cursor = cursor[segment];
  }
  return true;
};

const getPath = (obj: unknown, segments: readonly string[]): unknown => {
  let cursor: unknown = obj;
  for (const segment of segments) {
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
};

const setPath = (target: Record<string, unknown>, segments: readonly string[], value: unknown): void => {
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const next = cursor[segment];
    if (!isRecord(next)) {
      const created: Record<string, unknown> = Object.create(null);
      cursor[segment] = created;
      cursor = created;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  cursor[segments[segments.length - 1]] = value;
};

const omitPath = (obj: unknown, segments: readonly string[]): unknown => {
  if (!isRecord(obj) || !hasOwn(obj, segments[0])) {
    return obj;
  }
  const clone: Record<string, unknown> = { ...obj };
  if (segments.length === 1) {
    delete clone[segments[0]];
    return clone;
  }
  clone[segments[0]] = omitPath(clone[segments[0]], segments.slice(1));
  return clone;
};

const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

const splitPath = (path: string): string[] | null => {
  const segments = path.split(".").filter((segment) => segment.length > 0);
  if (segments.some((segment) => UNSAFE_SEGMENTS.has(segment))) {
    return null;
  }
  return segments;
};

export const projectPayload = (
  payload: unknown,
  options: { ignoreFields?: readonly string[]; pickFields?: readonly string[] },
): unknown => {
  const ignoreFields = options.ignoreFields ?? [];
  const pickFields = options.pickFields ?? [];
  if (ignoreFields.length === 0 && pickFields.length === 0) {
    return payload;
  }
  if (!isRecord(payload)) {
    return payload;
  }

  let result: unknown = payload;

  if (pickFields.length > 0) {
    const picked: Record<string, unknown> = Object.create(null);
    for (const path of pickFields) {
      const segments = splitPath(path);
      if (segments && segments.length > 0 && hasPath(result, segments)) {
        setPath(picked, segments, getPath(result, segments));
      }
    }
    result = picked;
  }

  for (const path of ignoreFields) {
    const segments = splitPath(path);
    if (segments && segments.length > 0) {
      result = omitPath(result, segments);
    }
  }

  return result;
};
