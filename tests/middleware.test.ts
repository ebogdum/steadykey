import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { IdempotencyManager, InMemoryIdempotencyStore } from "../src/index.js";
import { createIdempotencyMiddleware, fastifyIdempotency } from "../src/middleware.js";

const collectBody = (req: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });

describe("createIdempotencyMiddleware (HTTP)", () => {
  let server: http.Server;
  let baseUrl: string;
  let handlerCalls: number;

  beforeEach(async () => {
    handlerCalls = 0;
    const manager = new IdempotencyManager(new InMemoryIdempotencyStore(), { defaultTtlSeconds: 60 });
    const middleware = createIdempotencyMiddleware(manager, { execute: { pollIntervalMs: 20 } });

    server = http.createServer((req, res) => {
      void collectBody(req).then((body) => {
        (req as http.IncomingMessage & { body?: unknown }).body = body;
        middleware(req as never, res as never, async (err?: unknown) => {
          if (err) {
            res.statusCode = 500;
            res.end("error");
            return;
          }
          handlerCalls += 1;
          const delay = Number(req.headers["x-delay"] ?? 0);
          await new Promise((r) => setTimeout(r, delay));
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, call: handlerCalls }));
        });
      });
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (key: string | undefined, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/charge`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });

  it("runs the handler once and replays the stored response", async () => {
    const first = await post("k1", { amount: 100 });
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstBody).toEqual({ ok: true, call: 1 });

    const second = await post("k1", { amount: 100 });
    const secondBody = await second.json();
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(secondBody).toEqual({ ok: true, call: 1 });
    expect(handlerCalls).toBe(1);
  });

  it("runs the handler for different keys", async () => {
    await post("a", { amount: 1 });
    await post("b", { amount: 1 });
    expect(handlerCalls).toBe(2);
  });

  it("skips idempotency when no key is provided", async () => {
    await post(undefined, { amount: 1 });
    await post(undefined, { amount: 1 });
    expect(handlerCalls).toBe(2);
  });

  it("returns 422 when the same key is reused with a different body", async () => {
    await post("dup", { amount: 100 });
    const mismatch = await post("dup", { amount: 999 });
    expect(mismatch.status).toBe(422);
  });

  it("serializes concurrent duplicates to a single execution", async () => {
    const [a, b] = await Promise.all([
      post("race", { amount: 5 }, { "x-delay": "80" }),
      post("race", { amount: 5 }, { "x-delay": "80" }),
    ]);
    const bodies = [await a.json(), await b.json()];
    expect(handlerCalls).toBe(1);
    expect(bodies[0]).toEqual(bodies[1]);
  });
});

describe("fastifyIdempotency (hook logic)", () => {
  interface Hooks {
    preHandler?: (req: unknown, reply: unknown) => Promise<unknown>;
    onSend?: (req: unknown, reply: unknown, payload: unknown) => Promise<unknown>;
  }
  const makeReply = () => {
    const state = { statusCode: 200, headers: {} as Record<string, string>, sent: undefined as unknown };
    const reply = {
      statusCode: 200,
      code(status: number) {
        state.statusCode = status;
        reply.statusCode = status;
        return reply;
      },
      header(name: string, value: string) {
        state.headers[name] = value;
        return reply;
      },
      getHeader: (name: string) => state.headers[name],
      send(payload: unknown) {
        state.sent = payload;
        return reply;
      },
    };
    return { reply, state };
  };

  it("acquires, stores on send, and replays a duplicate", async () => {
    const manager = new IdempotencyManager(new InMemoryIdempotencyStore(), { defaultTtlSeconds: 60 });
    const hooks: Hooks = {};
    const fastify = {
      addHook: (name: "preHandler" | "onSend", handler: never) => {
        hooks[name] = handler;
      },
    };
    await fastifyIdempotency(manager, {})(fastify as never);

    const req1 = { method: "POST", headers: { "idempotency-key": "k" }, body: { amount: 1 } };
    const { reply: reply1, state: state1 } = makeReply();
    await hooks.preHandler!(req1, reply1);
    reply1.statusCode = 201;
    reply1.header("content-type", "application/json");
    await hooks.onSend!(req1, reply1, JSON.stringify({ ok: 1 }));

    const req2 = { method: "POST", headers: { "idempotency-key": "k" }, body: { amount: 1 } };
    const { reply: reply2, state: state2 } = makeReply();
    await hooks.preHandler!(req2, reply2);
    expect(state2.statusCode).toBe(201);
    expect(state2.headers["idempotent-replayed"]).toBe("true");
    expect(state2.sent).toBe(JSON.stringify({ ok: 1 }));
    expect(state1.sent).toBeUndefined();
  });
});
