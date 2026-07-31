import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { IdempotencyManager, InMemoryIdempotencyStore } from "../src/index.js";
import { createIdempotencyMiddleware, fastifyIdempotency } from "../src/middleware.js";
import { IdempotencyError } from "../src/errors.js";
import { deserializeRecord } from "../src/utils.js";

describe("stored record validation", () => {
  it("rejects a record missing payloadHash as a shape error", () => {
    expect(() => deserializeRecord(JSON.stringify({ id: "x", createdAt: "" }))).toThrow(IdempotencyError);
    expect(() => deserializeRecord(JSON.stringify({ id: "x", payloadHash: 42 }))).toThrow(IdempotencyError);
    expect(() => deserializeRecord(JSON.stringify({ id: "x", payloadHash: "h" }))).not.toThrow();
  });

  it("surfaces a malformed stored record as IdempotencyError, never a TypeError", async () => {
    const store = new InMemoryIdempotencyStore();
    const manager = new IdempotencyManager(store);
    const key = manager.buildKey(manager.generateId({ a: 1 }));
    await store.setIfAbsent(key, JSON.stringify({ id: "x", createdAt: "", status: "completed" }), null);

    await expect(manager.execute({ a: 1 }, async () => "ran")).rejects.toBeInstanceOf(IdempotencyError);
  });
});

describe("dot-path projection uses own properties", () => {
  const manager = new IdempotencyManager(new InMemoryIdempotencyStore());

  it("does not pick an inherited member off the prototype chain", () => {
    // `"toString" in {}` is true; picking it used to pull in a function and
    // blow up canonicalization.
    expect(() => manager.generateId({ amount: 1 }, { pickFields: ["toString"] })).not.toThrow();
    // Nothing matched, so the projection is empty — and stays distinct from the
    // unprojected payload.
    expect(manager.generateId({ amount: 1 }, { pickFields: ["toString"] })).not.toBe(
      manager.generateId({ amount: 1 }),
    );
  });

  it("ignores an inherited member without disturbing the payload", () => {
    expect(manager.generateId({ amount: 1 }, { ignoreFields: ["valueOf"] })).toBe(
      manager.generateId({ amount: 1 }, { ignoreFields: ["nope"] }),
    );
  });

  it("still picks and ignores genuine own fields", () => {
    expect(manager.generateId({ a: 1, b: 2 }, { pickFields: ["a"] })).toBe(
      manager.generateId({ a: 1 }, { pickFields: ["a"] }),
    );
    expect(manager.generateId({ a: 1, b: 2 }, { ignoreFields: ["b"] })).toBe(
      manager.generateId({ a: 1 }, { ignoreFields: ["b"] }),
    );
  });
});

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0xff, 0xe0]);

describe("response body fidelity (Express/Connect)", () => {
  const serve = async (handler: (res: http.ServerResponse) => void) => {
    const manager = new IdempotencyManager(new InMemoryIdempotencyStore(), { defaultTtlSeconds: 60 });
    const middleware = createIdempotencyMiddleware(manager, { execute: { pollIntervalMs: 20 } });
    let calls = 0;
    const server = http.createServer((req, res) => {
      middleware(req as never, res as never, () => {
        calls += 1;
        handler(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    return {
      port,
      calls: () => calls,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  };

  const fetchRaw = async (port: number, key: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "idempotency-key": key },
    });
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      replayed: response.headers.get("idempotent-replayed"),
    };
  };

  it("does not cache and corrupt a binary response", async () => {
    const server = await serve((res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "image/png");
      res.end(PNG_BYTES);
    });
    try {
      const first = await fetchRaw(server.port, "png");
      expect(Buffer.compare(first.bytes, PNG_BYTES)).toBe(0);

      const second = await fetchRaw(server.port, "png");
      // Replaying it would have returned UTF-8-mangled bytes, so it is not cached.
      expect(second.replayed).toBeNull();
      expect(Buffer.compare(second.bytes, PNG_BYTES)).toBe(0);
      expect(server.calls()).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("captures a body written with a non-UTF-8 encoding faithfully", async () => {
    const text = "hello encoded body";
    const server = await serve((res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end(Buffer.from(text, "utf8").toString("base64"), "base64");
    });
    try {
      const first = await fetchRaw(server.port, "b64");
      expect(first.bytes.toString("utf8")).toBe(text);

      const second = await fetchRaw(server.port, "b64");
      expect(second.replayed).toBe("true");
      // The replay must byte-match the original, not the base64 source string.
      expect(second.bytes.toString("utf8")).toBe(text);
      expect(server.calls()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("does not mistake a write callback for an encoding", async () => {
    // `res.write(chunk, callback)` is valid Node; reading argument two as an
    // encoding must not corrupt the captured copy.
    const server = await serve((res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.write("part-one", () => undefined);
      res.end("part-two");
    });
    try {
      const first = await fetchRaw(server.port, "cb");
      expect(first.bytes.toString("utf8")).toBe("part-onepart-two");

      const second = await fetchRaw(server.port, "cb");
      expect(second.replayed).toBe("true");
      expect(second.bytes.toString("utf8")).toBe("part-onepart-two");
      expect(server.calls()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("still caches an ordinary text response", async () => {
    const server = await serve((res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("plain body");
    });
    try {
      await fetchRaw(server.port, "txt");
      const second = await fetchRaw(server.port, "txt");
      expect(second.replayed).toBe("true");
      expect(second.bytes.toString("utf8")).toBe("plain body");
      expect(server.calls()).toBe(1);
    } finally {
      await server.close();
    }
  });
});

describe("response body fidelity (Fastify)", () => {
  let app: FastifyInstance;
  let calls: number;

  const build = async () => {
    calls = 0;
    const manager = new IdempotencyManager(new InMemoryIdempotencyStore(), { defaultTtlSeconds: 60 });
    app = Fastify();
    await app.register(fastifyIdempotency(manager, {}) as never);
    app.post("/png", async (_req, reply) => {
      calls += 1;
      reply.code(200).header("content-type", "image/png");
      return PNG_BYTES;
    });
    app.post("/json", async (_req, reply) => {
      calls += 1;
      reply.code(200);
      return { ok: true };
    });
    await app.ready();
  };

  const post = (url: string, key: string) =>
    app.inject({ method: "POST", url, headers: { "idempotency-key": key }, payload: { a: 1 } });

  it("does not cache a binary payload as a mangled string", async () => {
    await build();
    const first = await post("/png", "p1");
    expect(Buffer.compare(first.rawPayload, PNG_BYTES)).toBe(0);

    const second = await post("/png", "p1");
    expect(second.headers["idempotent-replayed"]).toBeUndefined();
    expect(Buffer.compare(second.rawPayload, PNG_BYTES)).toBe(0);
    expect(calls).toBe(2);
  });

  it("still caches an ordinary JSON response", async () => {
    await build();
    await post("/json", "j1");
    const second = await post("/json", "j1");
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(JSON.parse(second.body)).toEqual({ ok: true });
    expect(calls).toBe(1);
  });
});
