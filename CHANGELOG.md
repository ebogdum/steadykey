# Changelog

All notable changes to this project are documented here. This project adheres to [Semantic Versioning](https://semver.org/).

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
