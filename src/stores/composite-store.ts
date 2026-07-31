import { IdempotencyError } from "../errors.js";
import type { IdempotencyStore, IdempotencyStoreValue } from "../types.js";

export interface CompositeStoreOptions {
  readonly source: IdempotencyStore;
  readonly cache: IdempotencyStore;
  readonly cacheTtlSeconds?: number;
}

export class CompositeIdempotencyStore implements IdempotencyStore {
  private readonly source: IdempotencyStore;
  private readonly cache: IdempotencyStore;
  private readonly cacheTtlSeconds?: number;

  constructor(options: CompositeStoreOptions) {
    if (!options || !options.source || !options.cache) {
      throw new IdempotencyError("CompositeIdempotencyStore requires both a source and a cache store");
    }
    if (options.cacheTtlSeconds !== undefined && (!Number.isInteger(options.cacheTtlSeconds) || options.cacheTtlSeconds < 1)) {
      throw new IdempotencyError("cacheTtlSeconds must be a positive integer when provided");
    }
    this.source = options.source;
    this.cache = options.cache;
    this.cacheTtlSeconds = options.cacheTtlSeconds;
  }

  private cacheTtl(sourceTtl: number | null): number | null {
    if (this.cacheTtlSeconds === undefined) {
      return sourceTtl;
    }
    if (sourceTtl === null) {
      return this.cacheTtlSeconds;
    }
    return Math.min(sourceTtl, this.cacheTtlSeconds);
  }

  private async cachePut(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    try {
      await this.cache.delete(key);
      await this.cache.setIfAbsent(key, value, ttlSeconds);
    } catch {
      return;
    }
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean> {
    const inserted = await this.source.setIfAbsent(key, value, ttlSeconds);
    if (inserted) {
      await this.cachePut(key, value, this.cacheTtl(ttlSeconds));
    }
    return inserted;
  }

  async get(key: string): Promise<IdempotencyStoreValue | null> {
    const cached = await this.cache.get(key).catch(() => null);
    if (cached) {
      return cached;
    }
    const fromSource = await this.source.get(key);
    if (fromSource) {
      await this.cachePut(key, fromSource.value, this.cacheTtl(fromSource.ttlSeconds ?? null));
    }
    return fromSource;
  }

  /**
   * Reads straight from the source, refreshing the cache with what it finds.
   *
   * The cache is per-process, so an entry written by this node goes stale the
   * moment another node mutates the record. Serving a cached `pending` record
   * to a caller waiting for that record to settle would make it wait out its
   * whole timeout after the work had already finished.
   */
  async getConsistent(key: string): Promise<IdempotencyStoreValue | null> {
    const fromSource = await this.source.get(key);
    if (fromSource) {
      await this.cachePut(key, fromSource.value, this.cacheTtl(fromSource.ttlSeconds ?? null));
    } else {
      await this.cache.delete(key).catch(() => undefined);
    }
    return fromSource;
  }

  async update(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    await this.source.update(key, value, ttlSeconds);
    await this.cachePut(key, value, this.cacheTtl(ttlSeconds));
  }

  async delete(key: string): Promise<boolean> {
    const deleted = await this.source.delete(key);
    await this.cache.delete(key).catch(() => undefined);
    return deleted;
  }
}
