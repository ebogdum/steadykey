import { IdempotencyError } from "../errors.js";
import type { IdempotencyStore, IdempotencyStoreValue } from "../types.js";

type FetchLike = (input: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface UpstashRedisStoreOptions {
  readonly url: string;
  readonly token: string;
  readonly fetch?: FetchLike;
}

export class UpstashRedisIdempotencyStore implements IdempotencyStore {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: UpstashRedisStoreOptions) {
    if (!options || !options.url || !options.token) {
      throw new IdempotencyError("UpstashRedisIdempotencyStore requires a url and token");
    }
    this.url = options.url.replace(/\/+$/, "");
    this.token = options.token;
    const resolved = options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (!resolved) {
      throw new IdempotencyError("A fetch implementation is required for UpstashRedisIdempotencyStore");
    }
    this.fetchImpl = resolved;
  }

  private async command<T>(args: readonly (string | number)[]): Promise<T> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!response.ok) {
      throw new IdempotencyError(`Upstash Redis request failed with status ${response.status}`);
    }
    const payload = (await response.json()) as { result?: T; error?: string };
    if (payload && typeof payload === "object" && "error" in payload && payload.error) {
      throw new IdempotencyError(`Upstash Redis error: ${payload.error}`);
    }
    return payload.result as T;
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean> {
    const args: (string | number)[] = ["SET", key, value, "NX"];
    if (typeof ttlSeconds === "number" && ttlSeconds > 0) {
      args.push("EX", ttlSeconds);
    }
    const result = await this.command<string | null>(args);
    return result === "OK";
  }

  async get(key: string): Promise<IdempotencyStoreValue | null> {
    const value = await this.command<string | null>(["GET", key]);
    if (value === null || value === undefined) {
      return null;
    }
    const ttl = await this.command<number>(["TTL", key]);
    return { value, ttlSeconds: ttl < 0 ? null : ttl };
  }

  async update(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    const args: (string | number)[] = ["SET", key, value, "XX"];
    if (typeof ttlSeconds === "number" && ttlSeconds > 0) {
      args.push("EX", ttlSeconds);
    }
    const result = await this.command<string | null>(args);
    if (result !== "OK") {
      throw new IdempotencyError(`Failed to update key ${key} in Upstash Redis store`);
    }
    if (ttlSeconds === null) {
      await this.command<number>(["PERSIST", key]);
    }
  }

  async delete(key: string): Promise<boolean> {
    const deleted = await this.command<number>(["DEL", key]);
    return deleted > 0;
  }
}
