import { IdempotencyError } from "../errors.js";
import type { IdempotencyStore, IdempotencyStoreValue } from "../types.js";

export interface RedisSetOptions {
  NX?: boolean;
  XX?: boolean;
  EX?: number;
}

export interface RedisClientLike {
  set(key: string, value: string, options?: RedisSetOptions): Promise<string | null>;
  get(key: string): Promise<string | null>;
  ttl(key: string): Promise<number>;
  persist(key: string): Promise<boolean | number>;
  del(key: string): Promise<number>;
}

/** Redis replies -1 for "no expiry" and -2 for "no such key". */
const KEY_MISSING = -2;

const toTtlSeconds = (ttl: number): number | null => (ttl < 0 ? null : ttl);

export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: RedisClientLike) {
    if (!redis) {
      throw new IdempotencyError("Redis client instance is required for RedisIdempotencyStore");
    }
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean> {
    const options: RedisSetOptions = { NX: true };
    if (typeof ttlSeconds === "number" && ttlSeconds > 0) {
      options.EX = ttlSeconds;
    }
    const result = await this.redis.set(key, value, options);
    return result === "OK";
  }

  async get(key: string): Promise<IdempotencyStoreValue | null> {
    const value = await this.redis.get(key);
    if (value === null) {
      return null;
    }
    const ttl = await this.redis.ttl(key);
    if (ttl === KEY_MISSING) {
      // The key expired between the GET and the TTL; report it as gone rather
      // than as a record that never expires.
      return null;
    }
    return { value, ttlSeconds: toTtlSeconds(ttl) };
  }

  async update(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    const options: RedisSetOptions = { XX: true };
    if (typeof ttlSeconds === "number" && ttlSeconds > 0) {
      options.EX = ttlSeconds;
    }

    const result = await this.redis.set(key, value, options);
    if (result !== "OK") {
      throw new IdempotencyError(`Failed to update key ${key} in Redis store`);
    }

    if (ttlSeconds === null) {
      await this.redis.persist(key);
    }
  }

  async delete(key: string): Promise<boolean> {
    const deleted = await this.redis.del(key);
    return deleted > 0;
  }
}
