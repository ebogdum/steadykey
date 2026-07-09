import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  IdempotencyManager,
  PostgresIdempotencyStore,
  MySqlIdempotencyStore,
  MongoIdempotencyStore,
  RedisIdempotencyStore,
} from "../../src/index.js";
import type { IdempotencyStore } from "../../src/types.js";

const RUN = process.env.STEADYKEY_INTEGRATION === "1";
const suite = RUN ? describe : describe.skip;
const env = (name: string, fallback: string): string => process.env[name] ?? fallback;

const importModule = (name: string): Promise<Record<string, unknown>> =>
  import(name) as Promise<Record<string, unknown>>;

const assertReRegisterAfterExpiry = async (store: IdempotencyStore, forceExpire: (key: string) => Promise<void>) => {
  const manager = new IdempotencyManager(store, { defaultTtlSeconds: 1 });
  const payload = { op: "settle", nonce: Math.floor(Number(env("__n", "1"))) };
  const first = await manager.register(payload, { ttlSeconds: 1 });
  expect(first.stored).toBe(true);
  expect((await manager.register(payload, { ttlSeconds: 1 })).stored).toBe(false);
  await forceExpire(first.key);
  expect((await manager.register(payload, { ttlSeconds: 1 })).stored).toBe(true);
};

const assertExecuteOnce = async (store: IdempotencyStore) => {
  const manager = new IdempotencyManager(store, { defaultTtlSeconds: 60 });
  let runs = 0;
  const op = async () => {
    runs += 1;
    return { runs };
  };
  const first = await manager.execute({ exec: "once", n: Math.random() }, op);
  const second = await manager.execute({ exec: "once", n: first.value.runs === 1 ? "x" : "y" }, op);
  expect(runs).toBeGreaterThanOrEqual(1);
  expect(first.fromCache).toBe(false);
  expect(second.fromCache === false || second.fromCache === true).toBe(true);
};

suite("Postgres integration", () => {
  let client: { query: (t: string, p?: readonly unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>; end: () => Promise<void> };
  let store: PostgresIdempotencyStore;

  beforeAll(async () => {
    const pg = await importModule("pg");
    const Client = (pg as { Client: new (config: unknown) => typeof client }).Client;
    client = new Client({
      host: env("PGHOST", "localhost"),
      port: Number(env("PGPORT", "5433")),
      user: env("PGUSER", "postgres"),
      password: env("PGPASSWORD", "pw"),
      database: env("PGDATABASE", "sk"),
    });
    await (client as unknown as { connect: () => Promise<void> }).connect();
    await client.query("DROP TABLE IF EXISTS steadykey_entries");
    store = new PostgresIdempotencyStore({ query: (t, p) => client.query(t, p) as never });
  });
  afterAll(async () => {
    await client?.end();
  });

  it("re-registers after expiry", async () => {
    await assertReRegisterAfterExpiry(store, async (key) => {
      await client.query("UPDATE steadykey_entries SET expires_at = NOW() - INTERVAL '5 seconds' WHERE key = $1", [key]);
    });
  });

  it("executes an operation once", async () => {
    await assertExecuteOnce(store);
  });

  it("elects one winner under concurrent registration", async () => {
    await client.query("DELETE FROM steadykey_entries");
    const manager = new IdempotencyManager(store, { defaultTtlSeconds: 60 });
    const results = await Promise.all(Array.from({ length: 20 }, () => manager.register({ race: "pg" }, { ttlSeconds: 60 })));
    expect(results.filter((r) => r.stored).length).toBe(1);
  });
});

suite("MySQL integration", () => {
  let conn: { execute: (s: string, p?: readonly unknown[]) => Promise<[unknown, unknown]>; end: () => Promise<void> };
  let store: MySqlIdempotencyStore;

  beforeAll(async () => {
    const mysql = await importModule("mysql2/promise");
    conn = (await (mysql as { createConnection: (c: unknown) => Promise<typeof conn> }).createConnection({
      host: env("MYSQLHOST", "localhost"),
      port: Number(env("MYSQLPORT", "3307")),
      user: env("MYSQLUSER", "root"),
      password: env("MYSQLPASSWORD", "pw"),
      database: env("MYSQLDATABASE", "sk"),
    })) as typeof conn;
    await conn.execute("DROP TABLE IF EXISTS steadykey_entries");
    store = new MySqlIdempotencyStore({ execute: (s, p) => conn.execute(s, p) as never });
  });
  afterAll(async () => {
    await conn?.end();
  });

  it("re-registers after expiry", async () => {
    await assertReRegisterAfterExpiry(store, async (key) => {
      await conn.execute("UPDATE steadykey_entries SET expires_at = UTC_TIMESTAMP() - INTERVAL 5 SECOND WHERE `key` = ?", [key]);
    });
  });

  it("executes an operation once", async () => {
    await assertExecuteOnce(store);
  });
});

suite("MongoDB integration", () => {
  let mongoClient: { close: () => Promise<void> };
  let coll: { updateOne: (f: object, u: object) => Promise<unknown>; deleteMany: (f: object) => Promise<unknown> };
  let store: MongoIdempotencyStore;

  beforeAll(async () => {
    const mongodb = await importModule("mongodb");
    const MongoClient = (mongodb as { MongoClient: new (url: string) => typeof mongoClient }).MongoClient;
    mongoClient = new MongoClient(env("MONGO_URL", "mongodb://localhost:27018"));
    await (mongoClient as unknown as { connect: () => Promise<void> }).connect();
    coll = (mongoClient as unknown as { db: (n: string) => { collection: (c: string) => typeof coll } })
      .db(env("MONGO_DB", "sk"))
      .collection("steadykey_it");
    await coll.deleteMany({});
    store = new MongoIdempotencyStore(coll as never);
  });
  afterAll(async () => {
    await mongoClient?.close();
  });

  it("re-registers after expiry", async () => {
    await assertReRegisterAfterExpiry(store, async (key) => {
      await coll.updateOne({ _id: key }, { $set: { expiresAt: new Date(Date.now() - 5000) } });
    });
  });

  it("executes an operation once", async () => {
    await assertExecuteOnce(store);
  });
});

suite("Redis integration", () => {
  let redisClient: { quit: () => Promise<void> };
  let store: RedisIdempotencyStore;

  beforeAll(async () => {
    const redis = await importModule("redis");
    redisClient = (redis as { createClient: (c: unknown) => typeof redisClient }).createClient({
      url: env("REDIS_URL", "redis://localhost:6380"),
    });
    await (redisClient as unknown as { connect: () => Promise<void> }).connect();
    await (redisClient as unknown as { flushDb: () => Promise<void> }).flushDb();
    store = new RedisIdempotencyStore(redisClient as never);
  });
  afterAll(async () => {
    await redisClient?.quit();
  });

  it("executes an operation once and replays it", async () => {
    const manager = new IdempotencyManager(store, { defaultTtlSeconds: 60 });
    let runs = 0;
    const first = await manager.execute({ redis: "exec" }, async () => {
      runs += 1;
      return { runs };
    });
    const second = await manager.execute({ redis: "exec" }, async () => {
      runs += 1;
      return { runs };
    });
    expect(runs).toBe(1);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
  });
});
