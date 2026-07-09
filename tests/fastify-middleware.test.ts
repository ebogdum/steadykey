import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { IdempotencyManager, InMemoryIdempotencyStore } from "../src/index.js";
import { fastifyIdempotency } from "../src/middleware.js";

describe("fastifyIdempotency (real Fastify)", () => {
  let app: FastifyInstance;
  let handlerCalls: number;

  beforeEach(async () => {
    handlerCalls = 0;
    const manager = new IdempotencyManager(new InMemoryIdempotencyStore(), { defaultTtlSeconds: 60 });
    app = Fastify();
    await app.register(fastifyIdempotency(manager, {}) as never);
    app.post("/pay", async (_req, reply) => {
      handlerCalls += 1;
      reply.code(201);
      return { receiptId: "rcpt_1", handlerCalls };
    });
    await app.ready();
  });

  const pay = (key: string | undefined, body: unknown) =>
    app.inject({
      method: "POST",
      url: "/pay",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      payload: body,
    });

  it("runs the handler once and replays the stored response", async () => {
    const first = await pay("k1", { amount: 100 });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ receiptId: "rcpt_1", handlerCalls: 1 });

    const second = await pay("k1", { amount: 100 });
    expect(second.statusCode).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.json()).toEqual({ receiptId: "rcpt_1", handlerCalls: 1 });
    expect(handlerCalls).toBe(1);
  });

  it("runs the handler once per distinct key", async () => {
    await pay("a", { amount: 1 });
    await pay("b", { amount: 1 });
    expect(handlerCalls).toBe(2);
  });

  it("returns 422 when a key is reused with a different body", async () => {
    await pay("dup", { amount: 100 });
    const mismatch = await pay("dup", { amount: 999 });
    expect(mismatch.statusCode).toBe(422);
    expect(handlerCalls).toBe(1);
  });

  it("skips idempotency when no key is provided", async () => {
    await pay(undefined, { amount: 1 });
    await pay(undefined, { amount: 1 });
    expect(handlerCalls).toBe(2);
  });

  it("serializes concurrent duplicates to a single execution", async () => {
    const [a, b] = await Promise.all([pay("race", { amount: 5 }), pay("race", { amount: 5 })]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(handlerCalls).toBe(1);
    expect(statuses).toContain(201);
  });
});
