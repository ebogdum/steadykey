import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { IdempotencyManager, InMemoryIdempotencyStore } from "../src/index.js";
import { createIdempotencyMiddleware, fastifyIdempotency } from "../src/middleware.js";
import type { IdempotencyStore, IdempotencyStoreValue } from "../src/types.js";

/** Records the TTL each write is given, so lease behaviour can be asserted. */
class RecordingStore implements IdempotencyStore {
  public readonly inserts: { key: string; ttlSeconds: number | null }[] = [];
  public readonly updates: { key: string; ttlSeconds: number | null }[] = [];

  constructor(private readonly inner: IdempotencyStore = new InMemoryIdempotencyStore()) {}

  async setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean> {
    const inserted = await this.inner.setIfAbsent(key, value, ttlSeconds);
    if (inserted) {
      this.inserts.push({ key, ttlSeconds });
    }
    return inserted;
  }

  async get(key: string): Promise<IdempotencyStoreValue | null> {
    return this.inner.get(key);
  }

  async update(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    this.updates.push({ key, ttlSeconds });
    return this.inner.update(key, value, ttlSeconds);
  }

  async delete(key: string): Promise<boolean> {
    return this.inner.delete(key);
  }
}

describe("createIdempotencyMiddleware response buffering limits", () => {
  let server: http.Server;
  let baseUrl: string;
  let handlerCalls: number;

  beforeEach(async () => {
    handlerCalls = 0;
    const manager = new IdempotencyManager(new InMemoryIdempotencyStore(), { defaultTtlSeconds: 60 });
    const middleware = createIdempotencyMiddleware(manager, {
      maxBodyBytes: 1024,
      execute: { pollIntervalMs: 20 },
    });

    server = http.createServer((req, res) => {
      middleware(req as never, res as never, (err?: unknown) => {
        if (err) {
          res.statusCode = 500;
          res.end("error");
          return;
        }
        handlerCalls += 1;
        const size = Number(req.headers["x-size"] ?? 16);
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain");
        // Stream it out in chunks, the way a real large response arrives.
        for (let sent = 0; sent < size; sent += 256) {
          res.write("z".repeat(Math.min(256, size - sent)));
        }
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (key: string, size: number): Promise<{ status: number; body: string; replayed?: string }> =>
    fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { "idempotency-key": key, "x-size": String(size) },
    }).then(async (response) => ({
      status: response.status,
      body: await response.text(),
      replayed: response.headers.get("idempotent-replayed") ?? undefined,
    }));

  it("caches a response that stays within the limit", async () => {
    const first = await post("small", 512);
    expect(first.body.length).toBe(512);

    const second = await post("small", 512);
    expect(second.replayed).toBe("true");
    expect(handlerCalls).toBe(1);
  });

  it("does not buffer or cache a response that exceeds the limit", async () => {
    const first = await post("big", 8192);
    expect(first.status).toBe(200);
    // The client still receives the complete body — only caching is skipped.
    expect(first.body.length).toBe(8192);

    const second = await post("big", 8192);
    expect(second.status).toBe(200);
    expect(second.body.length).toBe(8192);
    expect(second.replayed).toBeUndefined();
    expect(handlerCalls).toBe(2);
  });

  it("rejects a non-positive maxBodyBytes", () => {
    const manager = new IdempotencyManager(new InMemoryIdempotencyStore());
    for (const bad of [0, -1, 1.5, NaN]) {
      expect(() => createIdempotencyMiddleware(manager, { maxBodyBytes: bad })).toThrow();
    }
  });
});

describe("createIdempotencyMiddleware replay validation", () => {
  it("runs the handler instead of replaying a record that is not a captured response", async () => {
    const manager = new IdempotencyManager(new InMemoryIdempotencyStore(), { defaultTtlSeconds: 60 });
    // Another code path already owns this key with a plain business result.
    await manager.register(null, { idempotencyKey: "shared", result: { orderId: 7 } });

    let handlerCalls = 0;
    const middleware = createIdempotencyMiddleware(manager, { execute: { pollIntervalMs: 20 } });
    const server = http.createServer((req, res) => {
      middleware(req as never, res as never, () => {
        handlerCalls += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain");
        res.end("fresh");
      });
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "idempotency-key": "shared" },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("fresh");
      expect(handlerCalls).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("fastifyIdempotency pending-record lease", () => {
  let app: FastifyInstance;
  let store: RecordingStore;

  beforeEach(async () => {
    store = new RecordingStore();
    const manager = new IdempotencyManager(store, { defaultTtlSeconds: 3600 });
    app = Fastify();
    await app.register(fastifyIdempotency(manager, { leaseSeconds: 5, maxBodyBytes: 1024 }) as never);
    app.post("/pay", async (_req, reply) => {
      reply.code(201);
      return { receiptId: "rcpt_1" };
    });
    app.post("/big", async (_req, reply) => {
      reply.code(200).header("content-type", "text/plain");
      return "z".repeat(4096);
    });
    await app.ready();
  });

  const post = (url: string, key: string) =>
    app.inject({ method: "POST", url, headers: { "idempotency-key": key }, payload: { amount: 1 } });

  it("writes the pending placeholder with a bounded lease, not the final TTL", async () => {
    await post("/pay", "k1");
    expect(store.inserts).toHaveLength(1);
    // Without the lease this would be 3600 — an aborted request would hold the
    // key (and the storage it occupies) for an hour.
    expect(store.inserts[0].ttlSeconds).toBe(5);
  });

  it("promotes the completed record to the manager's default TTL", async () => {
    await post("/pay", "k2");
    expect(store.updates).toHaveLength(1);
    expect(store.updates[0].ttlSeconds).toBe(3600);
  });

  it("still replays the cached response after the lease is promoted", async () => {
    const first = await post("/pay", "k3");
    expect(first.statusCode).toBe(201);
    const second = await post("/pay", "k3");
    expect(second.statusCode).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
  });

  it("does not cache a response larger than maxBodyBytes", async () => {
    const first = await post("/big", "big1");
    expect(first.statusCode).toBe(200);
    expect(first.body.length).toBe(4096);
    // The oversized record was cleared, so the key is free again.
    expect(store.updates).toHaveLength(0);

    const second = await post("/big", "big1");
    expect(second.statusCode).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBeUndefined();
  });
});
