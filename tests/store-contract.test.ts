import { describe, it, expect } from "vitest";
import { IdempotencyManager, InMemoryIdempotencyStore, SqliteIdempotencyStore } from "../src/index.js";
import type { IdempotencyStore } from "../src/types.js";

interface Harness {
  readonly store: IdempotencyStore;
  expire(key: string): void | Promise<void>;
}

const runStoreContract = (name: string, makeHarness: () => Harness | Promise<Harness>): void => {
  describe(`store contract: ${name}`, () => {
    it("stores a new record and returns the existing one on repeat", async () => {
      const { store } = await makeHarness();
      const manager = new IdempotencyManager(store, { defaultTtlSeconds: 60 });
      const payload = { op: "charge", amount: 100 };

      const first = await manager.register(payload, { metadata: { attempt: 1 } });
      expect(first.stored).toBe(true);

      const second = await manager.register(payload, { metadata: { attempt: 2 } });
      expect(second.stored).toBe(false);
      expect(second.record.metadata).toEqual({ attempt: 1 });
    });

    it("re-registers the same payload after its TTL has expired", async () => {
      const harness = await makeHarness();
      const manager = new IdempotencyManager(harness.store, { defaultTtlSeconds: 1 });
      const payload = { op: "charge", amount: 100 };

      const first = await manager.register(payload, { ttlSeconds: 1 });
      expect(first.stored).toBe(true);

      await harness.expire(first.key);

      const reRegistered = await manager.register(payload, { ttlSeconds: 1 });
      expect(reRegistered.stored).toBe(true);
    });

    it("does not overwrite a live key via setIfAbsent", async () => {
      const { store } = await makeHarness();
      const inserted = await store.setIfAbsent("k", "first", 100);
      expect(inserted).toBe(true);
      const again = await store.setIfAbsent("k", "second", 100);
      expect(again).toBe(false);
      const got = await store.get("k");
      expect(got?.value).toBe("first");
    });

    it("overwrites an expired key via setIfAbsent exactly once", async () => {
      const harness = await makeHarness();
      const inserted = await harness.store.setIfAbsent("k", "first", 1);
      expect(inserted).toBe(true);
      await harness.expire("k");

      const first = await harness.store.setIfAbsent("k", "second", 100);
      const second = await harness.store.setIfAbsent("k", "third", 100);
      expect(first).toBe(true);
      expect(second).toBe(false);
      const got = await harness.store.get("k");
      expect(got?.value).toBe("second");
    });

    it("updates, clears, and reports missing keys", async () => {
      const { store } = await makeHarness();
      await store.setIfAbsent("k", "v", 100);
      await store.update("k", "v2", null);
      const got = await store.get("k");
      expect(got?.value).toBe("v2");
      expect(got?.ttlSeconds).toBeNull();

      expect(await store.delete("k")).toBe(true);
      expect(await store.get("k")).toBeNull();
      await expect(store.update("k", "v3", 10)).rejects.toThrow();
    });
  });
};

runStoreContract("InMemoryIdempotencyStore", () => {
  const store = new InMemoryIdempotencyStore();
  return {
    store,
    expire: () => store.advanceTime(5000),
  };
});

let DatabaseSync: (new (path: string) => SqliteDbLike) | null = null;
interface SqliteStmtLike {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
}
interface SqliteDbLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmtLike;
  close(): void;
}
try {
  ({ DatabaseSync } = await import("node:sqlite") as unknown as {
    DatabaseSync: new (path: string) => SqliteDbLike;
  });
} catch {
  DatabaseSync = null;
}

const describeSqlite = DatabaseSync ? runStoreContract : () => describe.skip("store contract: real SQLite (node:sqlite unavailable)", () => {
  it("skipped", () => expect(true).toBe(true));
});

describeSqlite("SqliteIdempotencyStore (real node:sqlite)", () => {
  const db = new DatabaseSync!(":memory:");
  const adapter = {
    exec: (sql: string) => db.exec(sql),
    run: (sql: string, params: readonly unknown[] = []) => {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes) };
    },
    get: <T>(sql: string, params: readonly unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
  };
  const store = new SqliteIdempotencyStore(adapter);
  return {
    store,
    expire: (key: string) =>
      db.prepare(`UPDATE steadykey_entries SET expires_at = ? WHERE key = ?`).run(Math.floor(Date.now() / 1000) - 5, key),
  };
});
