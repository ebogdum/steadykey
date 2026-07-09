# Changelog

All notable changes to this project are documented here. This project adheres to [Semantic Versioning](https://semver.org/).

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
