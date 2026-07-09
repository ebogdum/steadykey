import { describe, it, expect } from "vitest";
import {
  CompositeIdempotencyStore,
  InMemoryIdempotencyStore,
  UpstashRedisIdempotencyStore,
  CloudflareD1IdempotencyStore,
  IdempotencyManager,
} from "../src/index.js";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/index.js";

describe("CompositeIdempotencyStore (read-through cache)", () => {
  it("keeps the source authoritative and serves from cache", async () => {
    const source = new InMemoryIdempotencyStore();
    const cache = new InMemoryIdempotencyStore();
    const store = new CompositeIdempotencyStore({ source, cache });

    expect(await store.setIfAbsent("k", "v1", 100)).toBe(true);
    expect(await store.setIfAbsent("k", "v2", 100)).toBe(false);
    expect((await source.get("k"))?.value).toBe("v1");
    expect((await cache.get("k"))?.value).toBe("v1");

    await store.update("k", "v3", 100);
    expect((await store.get("k"))?.value).toBe("v3");

    expect(await store.delete("k")).toBe(true);
    expect(await source.get("k")).toBeNull();
    expect(await cache.get("k")).toBeNull();
  });

  it("populates the cache on a source hit", async () => {
    const source = new InMemoryIdempotencyStore();
    const cache = new InMemoryIdempotencyStore();
    await source.setIfAbsent("k", "fromSource", 100);
    const store = new CompositeIdempotencyStore({ source, cache });
    expect((await store.get("k"))?.value).toBe("fromSource");
    expect((await cache.get("k"))?.value).toBe("fromSource");
  });

  it("works as a manager backend", async () => {
    const store = new CompositeIdempotencyStore({
      source: new InMemoryIdempotencyStore(),
      cache: new InMemoryIdempotencyStore(),
    });
    const manager = new IdempotencyManager(store, { defaultTtlSeconds: 60 });
    const first = await manager.register({ a: 1 });
    const second = await manager.register({ a: 1 });
    expect(first.stored).toBe(true);
    expect(second.stored).toBe(false);
  });
});

class FakeRedisOverRest {
  private readonly data = new Map<string, { value: string; expiresAt: number | null }>();

  fetch = async (_url: string, init: { body: string }) => {
    const args = JSON.parse(init.body) as string[];
    const result = this.run(args);
    return { ok: true, status: 200, json: async () => ({ result }) };
  };

  private live(key: string): { value: string; expiresAt: number | null } | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  private run(args: string[]): unknown {
    const [cmd, key, ...rest] = args;
    if (cmd === "SET") {
      const value = rest[0];
      const flags = rest.slice(1);
      const nx = flags.includes("NX");
      const xx = flags.includes("XX");
      const exIndex = flags.indexOf("EX");
      const ttl = exIndex >= 0 ? Number(flags[exIndex + 1]) : null;
      const exists = this.live(key) !== undefined;
      if (nx && exists) return null;
      if (xx && !exists) return null;
      this.data.set(key, { value, expiresAt: ttl ? Date.now() + ttl * 1000 : null });
      return "OK";
    }
    if (cmd === "GET") return this.live(key)?.value ?? null;
    if (cmd === "TTL") {
      const entry = this.live(key);
      if (!entry) return -2;
      if (entry.expiresAt === null) return -1;
      return Math.ceil((entry.expiresAt - Date.now()) / 1000);
    }
    if (cmd === "PERSIST") {
      const entry = this.live(key);
      if (!entry) return 0;
      entry.expiresAt = null;
      return 1;
    }
    if (cmd === "DEL") return this.data.delete(key) ? 1 : 0;
    throw new Error(`unsupported command ${cmd}`);
  }
}

describe("UpstashRedisIdempotencyStore", () => {
  const makeStore = () => {
    const redis = new FakeRedisOverRest();
    return new UpstashRedisIdempotencyStore({ url: "https://example.upstash.io", token: "t", fetch: redis.fetch });
  };

  it("implements atomic set-if-absent via SET NX", async () => {
    const store = makeStore();
    expect(await store.setIfAbsent("k", "v1", 100)).toBe(true);
    expect(await store.setIfAbsent("k", "v2", 100)).toBe(false);
    const got = await store.get("k");
    expect(got?.value).toBe("v1");
    expect(got?.ttlSeconds).toBeGreaterThan(90);
  });

  it("updates existing keys and removes TTL", async () => {
    const store = makeStore();
    await store.setIfAbsent("k", "v1", 100);
    await store.update("k", "v2", null);
    const got = await store.get("k");
    expect(got?.value).toBe("v2");
    expect(got?.ttlSeconds).toBeNull();
    await expect(store.update("missing", "x", 10)).rejects.toThrow();
  });

  it("deletes keys", async () => {
    const store = makeStore();
    await store.setIfAbsent("k", "v", null);
    expect(await store.delete("k")).toBe(true);
    expect(await store.get("k")).toBeNull();
  });

  it("drives the manager end to end", async () => {
    const manager = new IdempotencyManager(makeStore(), { defaultTtlSeconds: 60 });
    expect((await manager.register({ a: 1 })).stored).toBe(true);
    expect((await manager.register({ a: 1 })).stored).toBe(false);
  });
});

let DatabaseSync: (new (path: string) => D1Backed) | null = null;
interface D1Backed {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): { changes: number | bigint }; get(...p: unknown[]): unknown };
}
try {
  ({ DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: new (path: string) => D1Backed });
} catch {
  DatabaseSync = null;
}

const makeD1 = (): D1DatabaseLike => {
  const db = new DatabaseSync!(":memory:");
  return {
    exec: async (sql: string) => db.exec(sql),
    prepare: (sql: string): D1PreparedStatementLike => {
      const statement: D1PreparedStatementLike & { params: unknown[] } = {
        params: [],
        bind(...values: unknown[]) {
          statement.params = values;
          return statement;
        },
        run: async () => {
          const result = db.prepare(sql).run(...statement.params);
          return { meta: { changes: Number(result.changes) } };
        },
        first: async <T>() => (db.prepare(sql).get(...statement.params) ?? null) as T | null,
      };
      return statement;
    },
  };
};

const d1Describe = DatabaseSync ? describe : describe.skip;

d1Describe("CloudflareD1IdempotencyStore (atomic, real SQLite engine)", () => {
  it("performs atomic set-if-absent via INSERT ON CONFLICT", async () => {
    const store = new CloudflareD1IdempotencyStore(makeD1());
    expect(await store.setIfAbsent("k", "v1", 100)).toBe(true);
    expect(await store.setIfAbsent("k", "v2", 100)).toBe(false);
    const got = await store.get("k");
    expect(got?.value).toBe("v1");
    expect(got?.ttlSeconds).toBeGreaterThan(90);
  });

  it("re-registers after expiry, updates, and deletes", async () => {
    const db = makeD1();
    const store = new CloudflareD1IdempotencyStore(db);
    await store.setIfAbsent("k", "v1", 1);
    await db.prepare(`UPDATE steadykey_entries SET expires_at = ? WHERE key = ?`).bind(1, "k").run();
    expect(await store.setIfAbsent("k", "v2", 100)).toBe(true);
    expect((await store.get("k"))?.value).toBe("v2");

    await store.update("k", "v3", null);
    const updated = await store.get("k");
    expect(updated?.value).toBe("v3");
    expect(updated?.ttlSeconds).toBeNull();
    await expect(store.update("missing", "x", 10)).rejects.toThrow();

    expect(await store.delete("k")).toBe(true);
    expect(await store.get("k")).toBeNull();
  });

  it("drives the manager end to end", async () => {
    const manager = new IdempotencyManager(new CloudflareD1IdempotencyStore(makeD1()), { defaultTtlSeconds: 60 });
    expect((await manager.register({ a: 1 })).stored).toBe(true);
    expect((await manager.register({ a: 1 })).stored).toBe(false);
  });
});
