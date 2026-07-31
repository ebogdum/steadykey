# steadykey

**Idempotency for Node.js and TypeScript — deterministic keys, an execute-once runner, and HTTP middleware. Zero dependencies, any backend.**

steadykey makes sure the same operation only ever runs once. It turns any JSON payload into a stable idempotency key, coordinates concurrent duplicates with a pending/completed/failed lifecycle, caches the result, and replays it on retries. Use it to deduplicate API requests and guarantee exactly-once side effects — payments, emails, webhooks, and background jobs — across Redis, PostgreSQL, MySQL, MongoDB, SQLite, DynamoDB, Memcached, Upstash, Cloudflare D1, or your own store.

[![npm](https://img.shields.io/npm/v/steadykey.svg)](https://www.npmjs.com/package/steadykey)
[![license](https://img.shields.io/npm/l/steadykey.svg)](./LICENSE)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![types](https://img.shields.io/badge/types-included-blue)

```sh
npm install steadykey
```

No runtime dependencies. No required peer dependencies. Bring the database client you already use — steadykey types it structurally, so nothing extra is installed.

- [Why steadykey](#why-steadykey)
- [Quick start](#quick-start)
- [Run something exactly once: `execute()`](#run-something-exactly-once-execute)
- [Keys, namespaces, and field filtering](#keys-namespaces-and-field-filtering)
- [The record lifecycle](#the-record-lifecycle)
- [HTTP middleware](#http-middleware)
- [Backends](#backends)
- [Manager API](#manager-api)
- [Events and observability](#events-and-observability)
- [Security](#security)
- [Upgrading from 1.x](#upgrading-from-1x)

## Why steadykey

- **Execute-once, not just detect-once.** `execute()` runs your operation a single time, caches the result, and replays it to every duplicate and concurrent retry.
- **Deterministic keys.** The same logical payload always produces the same key — regardless of object key order, across machines and locales.
- **Collision-resistant and safe.** Every value is type-tagged before hashing, so `5`, `"5"`, and `5n` never collide, and payloads with a `__proto__` field can't be forged into a collision.
- **Concurrency-aware.** A pending/completed/failed lifecycle with a lease coordinates concurrent callers: one runs, the rest wait for the result or fail fast.
- **Any backend, zero dependencies.** Eleven adapters ship in the box — including edge stores (Upstash, Cloudflare D1) and a tiered cache — or implement a four-method interface for your own.
- **Batteries included.** HTTP middleware for Express, Connect, and Fastify; field filtering; namespaces; batch operations; event hooks; sliding TTL; pluggable hashing.

## Quick start

```ts
import { IdempotencyManager, RedisIdempotencyStore } from "steadykey";
import { createClient } from "redis";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const manager = new IdempotencyManager(new RedisIdempotencyStore(redis), {
  keyPrefix: "checkout",
  defaultTtlSeconds: 86_400,
});

const { value, fromCache } = await manager.execute({ orderId: "A-1", amount: 4200 }, async () => {
  return await chargeCustomer("A-1", 4200); // runs once; retries get the cached result
});
```

Just need the deterministic key, without storage?

```ts
import { steadyKey } from "steadykey";

steadyKey({ customerId: 123, items: ["A", "B"] });
// → same sha256 hash every time, whatever the key order
```

## Run something exactly once: `execute()`

`execute(payload, operation, options?)` is the ergonomic core. It derives a key, acquires a short-lived lease, runs your operation once, stores the result, and returns it. Duplicates and concurrent callers get the cached result instead of re-running the work.

```ts
const result = await manager.execute(payload, async () => doExpensiveWork(payload), {
  ttlSeconds: 3600,       // how long the completed result is cached
  leaseSeconds: 30,       // how long a single attempt may run before it can be retaken
  inFlight: "wait",       // "wait" (poll for the leader's result) or "fail-fast"
  failureMode: "retry",   // "retry" (default) or "cache" the failure
  waitTimeoutMs: 10_000,  // how long a waiter waits before throwing IdempotencyInProgressError
});

result.value;      // your operation's return value (live or cached)
result.fromCache;  // false on the run that did the work, true on replays
result.status;     // "completed"
```

**Concurrency.** The first caller becomes the leader and runs the operation; others wait and receive the same result (`inFlight: "wait"`), or immediately throw `IdempotencyInProgressError` (`inFlight: "fail-fast"`). If the leader crashes, its lease expires and the next caller transparently takes over.

**Failures.** By default a thrown error is **not** cached — the key is released so a later call retries. Set `failureMode: "cache"` to store the failure and replay the same error to duplicates (useful for deterministic, permanent failures).

> Exactly-once holds when the operation completes within its lease. If the work runs longer than `leaseSeconds`, the lease can be retaken and the operation may run more than once — size the lease above your worst-case duration. Results must be JSON-serializable to be cached (`storeResult: false` disables caching the value).

## Keys, namespaces, and field filtering

The idempotency key is derived from the payload, but you control exactly how.

```ts
// Ignore noisy fields (dot-paths supported) so semantically-equal requests dedupe:
manager.execute(payload, run, { ignoreFields: ["requestId", "meta.timestamp"] });

// Or key on only the fields that matter:
manager.execute(payload, run, { pickFields: ["orderId", "amount"] });

// Isolate keys per tenant/user/operation:
manager.register(payload, { namespace: tenantId });

// Bring your own key (e.g. a client Idempotency-Key header). steadykey still
// fingerprints the body and throws IdempotencyCollisionError if the same key is
// reused with a different payload (Stripe-style semantics):
manager.register(payload, { idempotencyKey: req.headers["idempotency-key"] });

// Swap the hash function (e.g. a faster non-crypto hash):
new IdempotencyManager(store, { hashFn: (canonical) => myXxhash(canonical) });
```

## The record lifecycle

Each key holds a record with a `status`: `pending`, `completed`, or `failed`. `execute()` manages this for you, but you can drive it manually:

```ts
const { id } = await manager.register(payload, { status: "pending" });
try {
  const result = await doWork();
  await manager.complete(id, result);   // status → completed, result stored
} catch (error) {
  await manager.fail(id, error);         // status → failed, error stored
}
```

## HTTP middleware

Drop-in middleware reads an `Idempotency-Key` header, runs the handler once, stores the response, and replays it on retries.

**Express / Connect:**

```ts
import express from "express";
import { IdempotencyManager, RedisIdempotencyStore } from "steadykey";
import { createIdempotencyMiddleware } from "steadykey/middleware";

const app = express();
app.use(express.json());

const manager = new IdempotencyManager(new RedisIdempotencyStore(redis), { defaultTtlSeconds: 86_400 });
app.use(createIdempotencyMiddleware(manager, { ttlSeconds: 86_400 }));

app.post("/payments", async (req, res) => {
  const receipt = await charge(req.body); // runs once per Idempotency-Key
  res.json(receipt);                        // replayed verbatim on retries
});
```

Concurrent duplicates are serialized (later callers wait for the first, or get `409` in `fail-fast` mode). Reusing a key with a different body returns `422`. Replays carry an `Idempotent-Replayed: true` header. By default only responses with status `< 500` are cached.

**Fastify:**

```ts
import { fastifyIdempotency } from "steadykey/middleware";
await app.register(fastifyIdempotency(manager, { ttlSeconds: 86_400 }));
```

Options: `{ headerName?, required?, methods?, ttlSeconds?, namespace?, fingerprint?, shouldStore?, replayHeader?, maxBodyBytes?, leaseSeconds?, execute? }`.

`maxBodyBytes` (default 1 MiB) caps the response body that will be buffered and cached — a larger response streams through untouched and is not stored, so a streaming or bulk-export endpoint cannot be used to exhaust memory or the backing store. `leaseSeconds` (default 30, Fastify plugin only) bounds how long the `pending` placeholder holds a key, so a request aborted mid-flight cannot lock the key indefinitely.

Cached bodies are stored as UTF-8 text. A response whose bytes are not valid UTF-8 — an image, a gzip frame, a stream — is sent to the client untouched but is **not** cached, since replaying it from a string would corrupt it. Idempotency for a binary endpoint is better expressed by caching a small JSON descriptor and serving the bytes from storage.

## Backends

Every adapter is dependency-free — you pass in a client you already have, typed structurally.

| Adapter | Client you provide | Atomic set-if-absent | TTL |
|---|---|---|---|
| `InMemoryIdempotencyStore` | none (built in) | ✅ | ✅ simulated clock |
| `RedisIdempotencyStore` | `redis` v4 client | `SET NX` | ✅ `EX` |
| `UpstashRedisIdempotencyStore` | `{ url, token }` (REST) | `SET NX` | ✅ `EX` |
| `MemcachedIdempotencyStore` | `memcached` client | `add` | ✅ |
| `PostgresIdempotencyStore` | `pg` `Pool`/`Client` | `INSERT … ON CONFLICT` | app-managed + index |
| `MySqlIdempotencyStore` | `mysql2/promise` | `INSERT IGNORE` | app-managed + index |
| `MongoIdempotencyStore` | MongoDB collection | upsert on `_id` | ✅ TTL index |
| `SqliteIdempotencyStore` | `better-sqlite3` or async | `INSERT … ON CONFLICT` | app-managed + index |
| `DynamoDbIdempotencyStore` | AWS SDK v3 document client | conditional `put` | ✅ native TTL |
| `CloudflareD1IdempotencyStore` | Workers `D1Database` binding | `INSERT … ON CONFLICT` | app-managed + index |
| `CompositeIdempotencyStore` | any two stores | delegates to source | delegates |

All adapters treat an expired-but-not-yet-purged record as absent, so re-registration after expiry always succeeds — even on stores (SQL, DynamoDB, Mongo) that reclaim expired rows lazily.

```ts
// Upstash Redis over HTTP — ideal for serverless/edge, fully atomic:
import { UpstashRedisIdempotencyStore } from "steadykey";
const store = new UpstashRedisIdempotencyStore({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Cloudflare Workers — atomic via a D1 database binding:
import { CloudflareD1IdempotencyStore } from "steadykey";
const d1Store = new CloudflareD1IdempotencyStore(env.DB);

// Tiered read-through cache — a fast local cache in front of a shared source:
import { CompositeIdempotencyStore, InMemoryIdempotencyStore } from "steadykey";
const tiered = new CompositeIdempotencyStore({
  source: new RedisIdempotencyStore(redis),   // authoritative, atomic
  cache: new InMemoryIdempotencyStore(),        // fast, bounded staleness
  cacheTtlSeconds: 5,
});
```

`InMemoryIdempotencyStore` reclaims expired entries on an amortized schedule (by write volume, and by elapsed time so a traffic spike is released once it goes quiet). `purgeExpired()` forces a sweep and returns how many entries it dropped; `size` reports how many are held.

### Writing your own store

```ts
interface IdempotencyStore {
  setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean>;
  get(key: string): Promise<IdempotencyStoreValue | null>;
  update(key: string, value: string, ttlSeconds: number | null): Promise<void>;
  delete(key: string): Promise<boolean>;
  getConsistent?(key: string): Promise<IdempotencyStoreValue | null>;
}
```

`setIfAbsent` must be atomic — that is the whole guarantee. Implement the optional `getConsistent` **only if your store puts a cache in front of a shared backend**: a record mutates from `pending` to `completed` while an operation is in flight, and coordination reads (waiting on another worker, checking lease ownership before committing) must observe that transition rather than a cached copy. Stores without a cache tier omit it, and `get` is used instead.

## Manager API

```ts
new IdempotencyManager(store, {
  keyPrefix?, namespace?, defaultTtlSeconds?, hashAlgorithm?, hashFn?,
  storeCanonicalPayload?, slidingTtl?, events?, maxKeyLength?,
});
```

`maxKeyLength` (default 512) caps the length of the key prefix, a namespace, and an idempotency id — worth keeping tight when the id comes from a client-supplied header.

| Method | Description |
|---|---|
| `execute(payload, op, options?)` | Run `op` once; replay the cached result to duplicates. |
| `register(payload, options?)` | Store a record on first sight. Returns `{ id, key, stored, record }`. |
| `complete(id, result, options?)` | Transition a record to `completed` with a result. |
| `fail(id, error, options?)` | Transition a record to `failed` with an error. |
| `lookupByPayload(payload, options?)` / `lookupById(id, options?)` | Fetch a record, or `null`. |
| `exists(payload, options?)` / `has(id, options?)` | Check presence without storing. |
| `registerMany(payloads, options?)` / `lookupMany(ids, options?)` | Bulk operations. |
| `generateId(payload, options?)` | The derived id, without touching the store. |
| `updateTtl(id, ttlSeconds, options?)` | Refresh, set, or remove a TTL (`null`/`0` = persistent). |
| `clear(id, options?)` | Delete a record. Returns `true` if one was removed. |
| `getDefaultTtlSeconds()` | The TTL applied when a call does not specify one. |

Derivation options (`namespace`, `idempotencyKey`, `ignoreFields`, `pickFields`) apply to `execute`, `register`, `lookupByPayload`, `generateId`, and `exists`.

`execute` additionally takes `leaseSeconds`, `inFlight`, `failureMode`, `storeResult`, `waitTimeoutMs`, and `pollIntervalMs`. A caller waiting on another worker starts at `pollIntervalMs` and backs off exponentially toward one second, so a long wait costs a handful of reads rather than one per interval for the whole timeout. Every wait is bounded by `waitTimeoutMs`, after which `IdempotencyInProgressError` is thrown.

## Events and observability

```ts
new IdempotencyManager(store, {
  events: {
    onHit: ({ id }) => metrics.increment("idempotency.hit"),
    onMiss: ({ id }) => metrics.increment("idempotency.miss"),
    onStore: ({ record }) => {},
    onCollision: ({ key }) => logger.warn("idempotency collision", { key }),
    onComplete: ({ record }) => {},
    onFail: ({ record }) => {},
  },
});
```

Event handlers are best-effort — a throwing handler never disrupts an operation. Enable `slidingTtl` (per manager or per `lookup`) to refresh a record's TTL each time it is read.

## Security

- **Injective canonicalization.** Distinct value types never share a key, JSON keys such as `__proto__` are preserved (never dropped or used to pollute a prototype), non-finite numbers and invalid dates are rejected, and deeply nested payloads are bounded.
- **Injection-safe backends.** SQL table names are strictly validated and quoted, and every value and timestamp is a bound parameter. Configurable lengths are range-checked.
- **Unambiguous key composition.** Each key segment is percent-encoded, so a client-supplied idempotency key can never impersonate another namespace, and the composed key is always safe for whitespace-sensitive wire protocols such as the Memcached text protocol. Segment lengths are capped (`maxKeyLength`, default 512), and a store that cannot hold a key faithfully — Memcached past 250 bytes, MySQL past its `key` column — rejects it rather than truncating it into a collision.
- **Bounded resource use.** The HTTP middlewares cap the response body they buffer and cache (`maxBodyBytes`), and the Fastify plugin holds a key with a short lease (`leaseSeconds`) so an aborted request cannot lock it or grow the store without bound.
- **Constant-time hash comparison.** Payload-fingerprint comparisons do not leak how many leading characters matched.
- **No ambient behavior.** steadykey never logs, reads environment variables, or makes network calls of its own — it only talks to the client you hand it.
- **Trust boundary.** Records read back from a store are trusted to have the shape steadykey wrote. A store that untrusted parties can write to is outside the threat model.

## Upgrading from 2.x

3.0 is a security release. `buildKey()` now percent-encodes each key segment, so **keys change for ids or namespaces containing `:`, `%`, whitespace, control characters, or non-ASCII** — a hex hash or UUID is unaffected. Drain or expire those entries before deploying. The MySQL store now rejects keys longer than its `key` column instead of letting the server truncate them: if you pass keys longer than 128 characters, set `keyLength` explicitly and widen the column with `ALTER TABLE`. Payloads containing a `Map` with non-string keys also produce different keys, now that Map keys are canonicalized structurally. See the [changelog](CHANGELOG.md) for the full list.

## Upgrading from 1.x

steadykey 2.0 hardens the canonical form (type-tagged values, `__proto__`-safe objects, locale-independent key ordering), so **generated keys differ from 1.x** — existing stored keys will not match after upgrading. Let them expire or drain them before deploying.

Also new in 2.0: `execute()` and the pending/completed/failed lifecycle, HTTP middleware (`steadykey/middleware`), namespaces, field filtering, explicit client keys, batch operations, event hooks, sliding TTL, and the Upstash, Cloudflare D1, and Composite stores. The deprecated `buildRedisKey()` alias was removed (use `buildKey()`). `IdempotencyManager` methods now accept an options object with a `namespace`; existing calls remain source-compatible.

## Development

```sh
npm install
npm test          # unit tests (Vitest) — no external services required
npm run build     # ESM + CJS + type declarations into dist/
npm run lint      # type-check with tsc
```

Integration tests run against real engines when you opt in — install the drivers you want and set `STEADYKEY_INTEGRATION=1`:

```sh
docker run -d -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=sk -p 5433:5432 postgres:16-alpine
npm install --no-save pg
STEADYKEY_INTEGRATION=1 npx vitest run tests/integration
```

## License

MIT
