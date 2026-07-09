import { describe, it, expect, beforeEach, vi } from "vitest";
import { IdempotencyManager, InMemoryIdempotencyStore, IdempotencyInProgressError, IdempotencyCollisionError } from "../src/index.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("execute() — run once, cache result", () => {
  let store: InMemoryIdempotencyStore;
  let manager: IdempotencyManager;

  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
    manager = new IdempotencyManager(store, { defaultTtlSeconds: 60 });
  });

  it("runs the operation once and replays the cached result", async () => {
    const op = vi.fn(async () => ({ charged: true, amount: 100 }));
    const first = await manager.execute({ orderId: "A" }, op);
    expect(first.fromCache).toBe(false);
    expect(first.value).toEqual({ charged: true, amount: 100 });

    const second = await manager.execute({ orderId: "A" }, op);
    expect(second.fromCache).toBe(true);
    expect(second.value).toEqual({ charged: true, amount: 100 });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent callers so the operation runs once", async () => {
    const gate = deferred<void>();
    let runs = 0;
    const op = async () => {
      runs += 1;
      await gate.promise;
      return { n: runs };
    };
    const a = manager.execute({ orderId: "B" }, op);
    const b = manager.execute({ orderId: "B" }, op);
    await new Promise((r) => setTimeout(r, 20));
    gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    expect(runs).toBe(1);
    const cached = [ra, rb].filter((r) => r.fromCache).length;
    expect(cached).toBe(1);
    expect(ra.value).toEqual(rb.value);
  });

  it("fails fast on an in-flight duplicate when configured", async () => {
    const gate = deferred<void>();
    const leader = manager.execute({ orderId: "C" }, async () => {
      await gate.promise;
      return 1;
    });
    await new Promise((r) => setTimeout(r, 20));
    await expect(manager.execute({ orderId: "C" }, async () => 2, { inFlight: "fail-fast" })).rejects.toBeInstanceOf(
      IdempotencyInProgressError,
    );
    gate.resolve();
    await leader;
  });
});

describe("execute() — failure policy", () => {
  let manager: IdempotencyManager;
  beforeEach(() => {
    manager = new IdempotencyManager(new InMemoryIdempotencyStore(), { defaultTtlSeconds: 60 });
  });

  it("does not cache failures by default (retryable)", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    await expect(manager.execute({ id: 1 }, op)).rejects.toThrow("boom");
    const retry = await manager.execute({ id: 1 }, op);
    expect(retry.value).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("caches and replays failures when failureMode is cache", async () => {
    const op = vi.fn().mockRejectedValue(new Error("permanent"));
    await expect(manager.execute({ id: 2 }, op, { failureMode: "cache" })).rejects.toThrow("permanent");
    await expect(manager.execute({ id: 2 }, op, { failureMode: "cache" })).rejects.toThrow("permanent");
    expect(op).toHaveBeenCalledTimes(1);
  });
});

describe("manual lifecycle: complete / fail", () => {
  let manager: IdempotencyManager;
  beforeEach(() => {
    manager = new IdempotencyManager(new InMemoryIdempotencyStore(), { defaultTtlSeconds: 60 });
  });

  it("registers pending then completes with a result", async () => {
    const { id, record } = await manager.register({ job: 1 }, { status: "pending" });
    expect(record.status).toBe("pending");
    await manager.complete(id, { done: true });
    const found = await manager.lookupById(id);
    expect(found?.record.status).toBe("completed");
    expect(found?.record.result).toEqual({ done: true });
  });

  it("marks a record failed", async () => {
    const { id } = await manager.register({ job: 2 }, { status: "pending" });
    await manager.fail(id, new Error("nope"));
    const found = await manager.lookupById(id);
    expect(found?.record.status).toBe("failed");
    expect(found?.record.error).toMatchObject({ message: "nope" });
  });
});

describe("key derivation: fields, namespace, explicit keys", () => {
  let manager: IdempotencyManager;
  beforeEach(() => {
    manager = new IdempotencyManager(new InMemoryIdempotencyStore(), { defaultTtlSeconds: 60 });
  });

  it("ignores configured fields when deriving the key", async () => {
    const a = manager.generateId({ amount: 1, requestId: "x", ts: 1 }, { ignoreFields: ["requestId", "ts"] });
    const b = manager.generateId({ amount: 1, requestId: "y", ts: 2 }, { ignoreFields: ["requestId", "ts"] });
    expect(a).toBe(b);
  });

  it("supports nested dot-path ignore", async () => {
    const a = manager.generateId({ a: { keep: 1, drop: 9 } }, { ignoreFields: ["a.drop"] });
    const b = manager.generateId({ a: { keep: 1, drop: 8 } }, { ignoreFields: ["a.drop"] });
    expect(a).toBe(b);
  });

  it("pickFields keeps only selected paths", async () => {
    const a = manager.generateId({ amount: 1, note: "hi" }, { pickFields: ["amount"] });
    const b = manager.generateId({ amount: 1, note: "bye" }, { pickFields: ["amount"] });
    expect(a).toBe(b);
  });

  it("isolates keys by namespace", async () => {
    await manager.register({ v: 1 }, { namespace: "tenant-a" });
    const other = await manager.lookupByPayload({ v: 1 }, { namespace: "tenant-b" });
    expect(other).toBeNull();
    const same = await manager.lookupByPayload({ v: 1 }, { namespace: "tenant-a" });
    expect(same).not.toBeNull();
  });

  it("detects body mismatch for an explicit idempotency key (Stripe semantics)", async () => {
    await manager.register({ amount: 100 }, { idempotencyKey: "client-key-1" });
    await expect(manager.register({ amount: 200 }, { idempotencyKey: "client-key-1" })).rejects.toBeInstanceOf(
      IdempotencyCollisionError,
    );
    const same = await manager.register({ amount: 100 }, { idempotencyKey: "client-key-1" });
    expect(same.stored).toBe(false);
  });

  it("supports a custom hash function", () => {
    const manager2 = new IdempotencyManager(new InMemoryIdempotencyStore(), {
      hashFn: (canonical) => `custom-${canonical.length}`,
    });
    expect(manager2.generateId({ a: 1 })).toMatch(/^custom-\d+$/);
  });

  it("does not pollute Object.prototype through pickFields/ignoreFields paths", () => {
    manager.generateId({ a: 1 }, { pickFields: ["__proto__.polluted", "a"] });
    manager.generateId({ a: 1 }, { ignoreFields: ["constructor.prototype.polluted"] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("conveniences: has/exists, batch, events, sliding ttl", () => {
  it("has() and exists() report presence", async () => {
    const manager = new IdempotencyManager(new InMemoryIdempotencyStore(), { defaultTtlSeconds: 60 });
    const { id } = await manager.register({ a: 1 });
    expect(await manager.has(id)).toBe(true);
    expect(await manager.exists({ a: 1 })).toBe(true);
    expect(await manager.exists({ a: 2 })).toBe(false);
  });

  it("registerMany / lookupMany operate in bulk", async () => {
    const manager = new IdempotencyManager(new InMemoryIdempotencyStore(), { defaultTtlSeconds: 60 });
    const results = await manager.registerMany([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(results.every((r) => r.stored)).toBe(true);
    const found = await manager.lookupMany(results.map((r) => r.id));
    expect(found.every((r) => r !== null)).toBe(true);
  });

  it("emits lifecycle events", async () => {
    const events = { onMiss: vi.fn(), onHit: vi.fn(), onStore: vi.fn(), onComplete: vi.fn() };
    const manager = new IdempotencyManager(new InMemoryIdempotencyStore(), { defaultTtlSeconds: 60, events });
    await manager.register({ a: 1 });
    await manager.register({ a: 1 });
    expect(events.onMiss).toHaveBeenCalledTimes(1);
    expect(events.onStore).toHaveBeenCalledTimes(1);
    expect(events.onHit).toHaveBeenCalledTimes(1);
  });

  it("refreshes TTL on lookup when slidingTtl is enabled", async () => {
    const store = new InMemoryIdempotencyStore();
    const manager = new IdempotencyManager(store, { defaultTtlSeconds: 100, slidingTtl: true });
    const { id } = await manager.register({ a: 1 }, { ttlSeconds: 100 });
    store.advanceTime(60_000);
    const refreshed = await manager.lookupById(id);
    expect((refreshed?.ttlSeconds ?? 0)).toBeGreaterThan(90);
  });
});
