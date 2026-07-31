import { describe, it, expect } from "vitest";
import {
  CompositeIdempotencyStore,
  IdempotencyManager,
  InMemoryIdempotencyStore,
  RedisIdempotencyStore,
  UpstashRedisIdempotencyStore,
} from "../src/index.js";
import { IdempotencyInProgressError } from "../src/errors.js";
import { indexBaseName } from "../src/internal/sql.js";
import type { IdempotencyStore, IdempotencyStoreValue } from "../src/types.js";
import type { RedisClientLike } from "../src/stores/redis-store.js";

describe("InMemoryIdempotencyStore memory reclamation", () => {
  it("reclaims expired entries instead of holding them forever", async () => {
    let clock = 1_000_000;
    const store = new InMemoryIdempotencyStore({ now: () => clock });

    for (let i = 0; i < 2_000; i += 1) {
      await store.setIfAbsent(`k${i}`, "v", 1);
    }
    expect(store.size).toBe(2_000);

    // Everything expires, then the burst of traffic stops. Nothing re-reads
    // these keys, so lazy per-key eviction never sees them.
    clock += 1_100;
    clock += 30_000;
    await store.get("anything");

    expect(store.size).toBe(0);
  });

  it("never sweeps a store that holds only persistent entries", async () => {
    let clock = 1_000_000;
    const store = new InMemoryIdempotencyStore({ now: () => clock });
    for (let i = 0; i < 500; i += 1) {
      await store.setIfAbsent(`p${i}`, "v", null);
    }
    clock += 10 * 60_000;
    await store.get("p0");
    expect(store.size).toBe(500);
  });

  it("exposes an explicit purge that reports what it removed", async () => {
    let clock = 1_000_000;
    const store = new InMemoryIdempotencyStore({ now: () => clock });
    await store.setIfAbsent("a", "v", 1);
    await store.setIfAbsent("b", "v", 1);
    await store.setIfAbsent("keep", "v", null);

    clock += 2_000;
    expect(store.purgeExpired()).toBe(2);
    expect(store.size).toBe(1);
    expect(store.purgeExpired()).toBe(0);
  });
});

describe("CompositeIdempotencyStore consistency", () => {
  it("serves coordination reads from the source, not the local cache", async () => {
    const source = new InMemoryIdempotencyStore();
    const cache = new InMemoryIdempotencyStore();
    const composite = new CompositeIdempotencyStore({ source, cache });

    await source.setIfAbsent("k", "original", null);
    await composite.get("k"); // populates the local cache
    // Another node mutates the shared record.
    await source.update("k", "updated", null);

    expect((await composite.get("k"))?.value).toBe("original");
    expect((await composite.getConsistent("k"))?.value).toBe("updated");
    // The consistent read also repairs the cache.
    expect((await composite.get("k"))?.value).toBe("updated");
  });

  it("reports a source deletion through a consistent read", async () => {
    const source = new InMemoryIdempotencyStore();
    const cache = new InMemoryIdempotencyStore();
    const composite = new CompositeIdempotencyStore({ source, cache });

    await source.setIfAbsent("k", "v", null);
    await composite.get("k");
    await source.delete("k");

    expect(await composite.getConsistent("k")).toBeNull();
    expect(await composite.get("k")).toBeNull();
  });

  it("lets a waiting node observe another node completing the operation", async () => {
    const source = new InMemoryIdempotencyStore();
    const nodeA = new IdempotencyManager(source);
    const nodeB = new IdempotencyManager(
      new CompositeIdempotencyStore({ source, cache: new InMemoryIdempotencyStore() }),
    );

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const aDone = nodeA.execute({ op: "pay" }, async () => {
      await gate;
      return { ok: true };
    });

    await new Promise((r) => setTimeout(r, 30));
    const bPending = nodeB.execute({ op: "pay" }, async () => ({ shouldNotRun: true }), {
      waitTimeoutMs: 2_000,
      pollIntervalMs: 20,
    });

    await new Promise((r) => setTimeout(r, 50));
    release();
    await aDone;

    // Before the fix node B kept reading its cached `pending` copy and timed out.
    const b = await bPending;
    expect(b.value).toEqual({ ok: true });
    expect(b.fromCache).toBe(true);
  });
});

/**
 * Models permanent contention: another worker always wins the key and always
 * leaves behind a `failed` record for the same payload, so a `retry` caller
 * deletes it and loops. The record echoes the caller's own payload hash, so
 * this is a genuine retry loop rather than a collision.
 */
class AlwaysFailedStore implements IdempotencyStore {
  public reads = 0;
  private lastWritten: string | null = null;

  async setIfAbsent(_key: string, value: string): Promise<boolean> {
    this.lastWritten = value;
    return false;
  }

  async get(): Promise<IdempotencyStoreValue | null> {
    this.reads += 1;
    const written = this.lastWritten ? (JSON.parse(this.lastWritten) as Record<string, unknown>) : {};
    return {
      value: JSON.stringify({ ...written, status: "failed" }),
      ttlSeconds: null,
    };
  }

  async update(): Promise<void> {}

  async delete(): Promise<boolean> {
    return true;
  }
}

describe("execute() loop bounds", () => {
  it("honours waitTimeoutMs on the retry-after-failure path instead of spinning", async () => {
    const store = new AlwaysFailedStore();
    const manager = new IdempotencyManager(store);
    let ran = 0;

    const started = Date.now();
    await expect(
      manager.execute(
        { id: 1 },
        async () => {
          ran += 1;
          return 1;
        },
        { failureMode: "retry", waitTimeoutMs: 300, pollIntervalMs: 10 },
      ),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);

    expect(ran).toBe(0);
    // Bounded by the timeout rather than looping forever, and backed off rather
    // than hammering the store once per poll interval.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(store.reads).toBeLessThan(30);
  });

  it("backs off while waiting, rather than reading once per poll interval", async () => {
    const inner = new InMemoryIdempotencyStore();
    let reads = 0;
    const counting: IdempotencyStore = {
      setIfAbsent: (k, v, t) => inner.setIfAbsent(k, v, t),
      get: (k) => {
        reads += 1;
        return inner.get(k);
      },
      update: (k, v, t) => inner.update(k, v, t),
      delete: (k) => inner.delete(k),
    };

    const leader = new IdempotencyManager(inner);
    const waiter = new IdempotencyManager(counting);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const leading = leader.execute({ op: "slow" }, async () => {
      await gate;
      return "done";
    });

    await new Promise((r) => setTimeout(r, 20));
    const waiting = waiter.execute({ op: "slow" }, async () => "not-run", {
      waitTimeoutMs: 5_000,
      pollIntervalMs: 10,
    });

    await new Promise((r) => setTimeout(r, 800));
    release();
    await leading;
    expect((await waiting).value).toBe("done");

    // A flat 10ms poll over ~800ms would be ~80 reads; backoff keeps it small.
    expect(reads).toBeLessThan(25);
  });
});

describe("Redis TTL race", () => {
  const clientWithTtl = (ttl: number): RedisClientLike => ({
    set: async () => "OK",
    get: async () => "stored-value",
    ttl: async () => ttl,
    persist: async () => 1,
    del: async () => 1,
  });

  it("reports a key that expired between GET and TTL as absent", async () => {
    const store = new RedisIdempotencyStore(clientWithTtl(-2));
    expect(await store.get("k")).toBeNull();
  });

  it("still reports a persistent key as present with no TTL", async () => {
    const store = new RedisIdempotencyStore(clientWithTtl(-1));
    expect(await store.get("k")).toEqual({ value: "stored-value", ttlSeconds: null });
  });

  it("applies the same rule to the Upstash REST store", async () => {
    const replies: unknown[] = ["stored-value", -2];
    let call = 0;
    const store = new UpstashRedisIdempotencyStore({
      url: "https://example.upstash.io",
      token: "t",
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ result: replies[call++] }),
      }),
    });
    expect(await store.get("k")).toBeNull();
  });
});

describe("SQL index naming", () => {
  it("keeps a plain table's index name unchanged", () => {
    expect(indexBaseName("steadykey_entries")).toBe("steadykey_entries");
  });

  it("does not collide a schema-qualified name with its flattened form", () => {
    expect(indexBaseName("schema.entries")).not.toBe(indexBaseName("schema_entries"));
  });

  it("produces a safe, stable identifier for qualified names", () => {
    const name = indexBaseName("schema.entries");
    expect(name).toMatch(/^[A-Za-z0-9_]+$/);
    expect(indexBaseName("schema.entries")).toBe(name);
  });
});
