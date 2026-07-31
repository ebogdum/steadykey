import { IdempotencyError } from "../errors.js";
import { assertStorableKey } from "../internal/key.js";
import type { IdempotencyStore, IdempotencyStoreValue, MemcachedClientLike } from "../types.js";

/** The Memcached protocol caps keys at 250 bytes and forbids whitespace and control characters. */
const MAX_KEY_BYTES = 250;

const assertKey = (key: string): void => assertStorableKey(key, MAX_KEY_BYTES, "Memcached");

const wrap = <T>(invoke: (callback: (error: unknown, result: T) => void) => void): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    try {
      invoke((error, result) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });

const lifetimeFromTtl = (ttlSeconds: number | null): number => {
  if (typeof ttlSeconds === "number" && ttlSeconds > 0) {
    return ttlSeconds;
  }
  return 0;
};

export class MemcachedIdempotencyStore implements IdempotencyStore {
  constructor(private readonly client: MemcachedClientLike) {
    if (!client) {
      throw new IdempotencyError("Memcached client instance is required for MemcachedIdempotencyStore");
    }
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean> {
    assertKey(key);
    const lifetime = lifetimeFromTtl(ttlSeconds);
    const success = await wrap<boolean | string>((callback) => this.client.add(key, value, lifetime, callback));
    return Boolean(success);
  }

  async get(key: string): Promise<IdempotencyStoreValue | null> {
    assertKey(key);
    const data = await wrap<string | undefined | null>((callback) => this.client.get(key, callback));
    if (data === undefined || data === null) {
      return null;
    }
    return { value: data, ttlSeconds: undefined };
  }

  async update(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    assertKey(key);
    const lifetime = lifetimeFromTtl(ttlSeconds);
    const success = await wrap<boolean | string>((callback) => this.client.set(key, value, lifetime, callback));
    if (!success) {
      throw new IdempotencyError(`Failed to update key ${key} in Memcached store`);
    }
  }

  async delete(key: string): Promise<boolean> {
    assertKey(key);
    const success = await wrap<boolean | string>((callback) => this.client.del(key, callback));
    return Boolean(success);
  }
}
