# Changelog

All notable changes to this project are documented here. This project adheres to [Semantic Versioning](https://semver.org/).

## 3.1.1

Performance. **Generated keys are unchanged** — the canonical form is byte-identical to 3.1.0, verified by differentially fuzzing the old and new builds over 296,654 generated payloads (including class instances, typed arrays, null-prototype objects, `Map`/`Set`, lone surrogates, and array-index keys): zero divergence in either the canonical string or the final hash.

Measured on Node 25, median of 15 samples, each variant in its own process:

| Operation | Before | After | |
|---|---|---|---|
| `steadyKey` (small payload) | 1048 ns | 692 ns | **1.52x** |
| `steadyKey` (realistic payload) | 5004 ns | 3793 ns | **1.32x** |
| `steadyKey` (200-row payload) | 147.5 µs | 111.4 µs | **1.32x** |
| `steadyKey` (sha512) | 5361 ns | 3571 ns | **1.50x** |
| `canonicalize` | 3977 ns | 2823 ns | **1.41x** |
| `buildKey` | 107 ns | 78 ns | **1.38x** |

### Changed

- **`canonicalize` emits its JSON in a single pass** instead of building a parallel normalized object graph and then stringifying it.
- **Strings are quoted without a `JSON.stringify` call** when they contain nothing needing an escape, which is nearly always. The scan runs on the raw value rather than on `prefix + value`, since concatenating first forces V8 to flatten the rope before the scan can start — that detail alone was worth 2.2x on the per-string cost.
- **Type dispatch is ordered by real-world frequency**, and a plain object is recognised from its constructor so `instanceof Date` / `Buffer.isBuffer` / `instanceof Map` / `instanceof Set` are skipped entirely for the common case. `Buffer.isBuffer` alone measured 2.7x the cost of the other probes and ran on every value.
- **Key sorting uses the default `Array#sort`**, whose ordering is already UTF-16 code units, avoiding a comparator callback per comparison.
- **Hashing uses the one-shot `crypto.hash`** on Node 20.12+ / 21.7+, which is ~2x faster than allocating and driving a streaming `Hash`. Node 18 and 19 fall back to `createHash`.
- **`buildKey` skips the escape pass** when a segment contains nothing to escape.

### Added

- `npm run bench` — reproducible benchmarks for the hot paths, in `bench/`.

## 3.1.0

Correctness and robustness pass over the whole codebase, found by an adversarial review. No breaking changes.

### Fixed

- **`CompositeIdempotencyStore` could strand a caller waiting on another node.** The per-process cache served a stale `pending` copy of a record that the shared source had already moved to `completed`, so the waiter timed out with `IdempotencyInProgressError` after the work had finished. Coordination reads now bypass the cache tier through the new optional `IdempotencyStore.getConsistent`, and the read repairs the cache with what it finds.
- **`InMemoryIdempotencyStore` never reclaimed expired entries.** Eviction was lazy and per-key, so a process that wrote many short-lived keys and never read them back grew without bound. Entries are now swept on an amortized schedule — by write volume, and by elapsed time so a traffic spike is released once it goes quiet. A store holding only persistent entries is never scanned.
- **`execute()` could loop without honouring `waitTimeoutMs`.** The retry-after-failure and record-vanished paths looped straight back to the claim attempt with no deadline check and no delay, spinning against the store under contention. Every path that retries is now bounded by the deadline.
- **Waiters hammered the store.** A caller blocked on another worker read once per `pollIntervalMs` for the whole timeout — 100 reads per waiter at the defaults, multiplied by every duplicate request. Polling now backs off exponentially toward one second. `pollIntervalMs` is the starting interval.
- **Binary responses were cached corrupted.** Both middlewares stored the body as a UTF-8 string, which mangles bytes that are not valid UTF-8, and the Fastify plugin turned a non-string payload into `"[object Object]"` via `String()`. Such responses are now streamed through and left uncached.
- **A body written with an explicit encoding was captured wrongly.** `res.write(chunk, "base64")` was read back as UTF-8. The encoding argument is now honoured, a write callback in that position is no longer mistaken for one, and a capture failure can never break the response it is observing.
- **A malformed stored record crashed with `TypeError`.** A record missing `payloadHash` reached a constant-time comparison that rejects non-strings. `deserializeRecord` now validates the field, so it surfaces as `IdempotencyError` like every other bad-shape case.
- **`pickFields` / `ignoreFields` matched inherited properties.** Paths were tested with `in`, so `pickFields: ["toString"]` resolved a function off the prototype chain and broke canonicalization. Own properties only.
- **Redis and Upstash reported an expired key as persistent.** A key that vanished between the `GET` and the `TTL` returned its value with `ttlSeconds: null` ("never expires") instead of being reported absent.
- **Schema-qualified tables could silently lose their index.** `schema.entries` and `schema_entries` flattened to the same index name, and because `CREATE INDEX IF NOT EXISTS` is a no-op when the name is taken, the second table ended up with no index on `expires_at`. Plain table names are unchanged; qualified ones get a digest suffix.
- `MongoCollectionLike` no longer requires `insertOne`, which steadykey never calls, and `createIndex` is optional — needed only when the store manages its own TTL index.

### Added

- `IdempotencyStore.getConsistent?()` — optional; implement it only in a store that fronts a shared backend with a cache.
- `InMemoryIdempotencyStore#purgeExpired()` and `#size` — force a sweep and report how many entries are held.

## 3.0.0

Security release. Every issue below is reachable when the idempotency key comes from an untrusted source — which is the normal case for the HTTP middleware, where it is read straight from the `Idempotency-Key` request header.

### Breaking

- **Store keys are now escaped.** `buildKey()` percent-encodes each segment (the namespace and the id), so a key is composed unambiguously. Keys change **only** for ids or namespaces containing `:`, `%`, whitespace, control characters, or non-ASCII; a hex hash or a UUID is unaffected. If your keys contain any of those, existing entries will not be found after upgrading — let them expire or drain them before deploying.
- **The MySQL store rejects keys longer than its `key` column** instead of letting the server truncate them. The default remains `keyLength: 128`, matching the column that `ensureTable` creates. If you pass keys longer than 128 characters, set `keyLength` explicitly *and* widen the column with `ALTER TABLE`.
- **Keys are length-capped.** The prefix, namespace, and id are each limited to 512 characters by default, configurable via the new `maxKeyLength` option.
- **`Map` keys are canonicalized structurally**, so keys generated for payloads containing a `Map` with non-string keys differ from 2.x.
- Requires ESLint 10 to develop against (no effect on consumers; the package still ships zero runtime dependencies).

### Fixed

- **Key-segment injection.** An attacker-supplied idempotency key containing `:` could compose a key belonging to a different namespace — for example sending `Idempotency-Key: tenantB:<key>` to an endpoint served by an unnamespaced manager sharing the same backend. With a guessable request body the attacker could pre-seed that key, so the victim's request would be answered from the poisoned record and their operation silently skipped. Segments are now escaped, making key composition injective.
- **Memcached protocol injection.** Keys were passed to the client verbatim. A key containing whitespace or `\r\n` breaks the Memcached text protocol and can inject commands (`flush_all`, `set`, …). The store now rejects unsafe keys and keys past the 250-byte protocol limit, and `buildKey()` no longer produces them.
- **MySQL key aliasing.** Keys longer than the `VARCHAR(128)` primary key were silently truncated by a non-strict server, collapsing two distinct idempotency keys onto one row.
- **Unbounded response buffering in the HTTP middleware.** Both the Express/Connect middleware and the Fastify plugin buffered the entire response body in memory and wrote it to the store, with no cap. Any endpoint returning a large or streamed body could be used to exhaust process memory and the backing store. Bodies are now capped by the new `maxBodyBytes` option (default 1 MiB); a response past the cap streams through untouched and is not cached.
- **Permanent key lock and unbounded store growth in the Fastify plugin.** The `pending` placeholder was written with the *final* TTL — with no `defaultTtlSeconds`, that meant no expiry at all. A request aborted before `onSend` left the key locked forever, returning `409` on every retry, and repeated aborts grew the store without bound. The placeholder now uses a short lease (new `leaseSeconds` option, default 30s) that is promoted to the real TTL once the response is known.
- **Malformed cached records are no longer replayed.** A record that is not a captured HTTP response (written by another code path sharing the key space, or corrupted) previously produced an invalid status code or header. The middleware now validates the record and falls through to the handler instead.
- **Payload hashes are compared in constant time**, so the comparison no longer leaks how many leading characters matched.
- **`Map` canonicalization collision.** Map keys were coerced with `String()`, so `new Map([[1, "x"]])` and `new Map([["1", "x"]])` — and any two object keys — produced the same idempotency key, meaning one request could be served another's cached response. Keys are now canonicalized structurally, like every other value.
- **Key prefixes are validated** to contain only printable, non-whitespace ASCII.
- All dependency advisories resolved (`npm audit`: 0 vulnerabilities). ESLint upgraded to 10, and `minimatch` / `brace-expansion` pinned to patched versions through `overrides`. All were development-only; the published package has no runtime dependencies.

### Added

- `maxKeyLength` on `IdempotencyManager` — caps the length of the key prefix, a namespace, and an id. Default 512.
- `maxBodyBytes` on both middlewares — caps the response body that will be buffered and cached. Default 1 MiB.
- `leaseSeconds` on the Fastify plugin — bounds how long the pending placeholder holds a key. Default 30s.
- `IdempotencyManager#getDefaultTtlSeconds()` — reads back the configured default TTL.

## 2.0.0

### Breaking

- **Canonicalization is now injective.** Every value is type-tagged before hashing, plain strings are tagged, non-finite numbers and invalid dates are rejected, and object keys are ordered by UTF-16 code unit instead of the environment-dependent locale. As a result, **generated keys differ from 1.x** — existing stored keys will not match after upgrading. Let them expire or drain them before deploying.
- Removed the deprecated `buildRedisKey()` alias. Use `buildKey()`.

### Added

- **`execute(payload, operation, options?)`** — runs an operation exactly once, caches the result, and replays it to duplicates and concurrent callers.
- **Record lifecycle** — `pending` / `completed` / `failed` status, stored results and errors, and manual `complete(id, result)` / `fail(id, error)` transitions.
- **Concurrency control** — lease-based coordination with `inFlight: "wait" | "fail-fast"`, `leaseSeconds`, `waitTimeoutMs`, and crashed-leader takeover. Adds `IdempotencyInProgressError`.
- **Failure policy** — `failureMode: "retry" | "cache"`.
- **Key derivation** — `namespace` scoping, `ignoreFields` / `pickFields` (dot-path) projection, explicit client `idempotencyKey` with body-fingerprint collision detection, and a pluggable `hashFn`.
- **HTTP middleware** (`steadykey/middleware`) — `createIdempotencyMiddleware` for Express/Connect and `fastifyIdempotency` for Fastify, reading the `Idempotency-Key` header, storing responses, and replaying them.
- **New stores** — `UpstashRedisIdempotencyStore` (REST), `CloudflareD1IdempotencyStore` (atomic, for Cloudflare Workers), and `CompositeIdempotencyStore` (tiered read-through cache).
- **Conveniences** — `registerMany` / `lookupMany`, `has` / `exists`, event hooks (`onHit`, `onMiss`, `onStore`, `onCollision`, `onComplete`, `onFail`), and `slidingTtl`.
- `engines.node >= 18`, `sideEffects: false`, and a `./middleware` export.

### Fixed

- **Expired keys can be re-registered.** On PostgreSQL, MySQL, SQLite, MongoDB, and DynamoDB, an expired-but-not-yet-purged record no longer permanently blocks re-registration of the same key.
- **MySQL TTLs are timezone-correct.** Expiry is compared against a bound timestamp instead of the database clock, fixing early/late expiry on non-UTC connections.
- **`__proto__` idempotency-bypass.** A payload with an own `__proto__` key is no longer dropped from the canonical form (which allowed forcing a key collision).
- **MySQL `keyLength` is validated** before it reaches DDL.
- **Lazy expiry cleanup is race-safe** on MongoDB and DynamoDB (only deletes a record that is still expired).
- DynamoDB reads default to strongly consistent, so a read after a losing conditional write reliably returns the winning record.

### Changed

- Zero runtime dependencies and zero required peer dependencies (the `redis` peer dependency was removed; the client is now typed structurally).
- Shared SQL helpers centralize identifier validation and TTL math across the SQL adapters.
