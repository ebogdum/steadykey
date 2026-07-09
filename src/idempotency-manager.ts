import { randomUUID } from "crypto";
import { canonicalize, deserializeRecord, hashCanonicalValue, serializeRecord } from "./utils.js";
import { projectPayload } from "./internal/project.js";
import { IdempotencyCollisionError, IdempotencyError, IdempotencyInProgressError } from "./errors.js";
import type {
  FailureMode,
  HashAlgorithm,
  HashFunction,
  IdempotencyEvents,
  IdempotencyExecuteOptions,
  IdempotencyExecuteResult,
  IdempotencyLookupOptions,
  IdempotencyLookupResult,
  IdempotencyManagerOptions,
  IdempotencyMutateOptions,
  IdempotencyRecord,
  IdempotencyRegisterOptions,
  IdempotencyRegistrationResult,
  IdempotencyStatus,
  IdempotencyStore,
  IdempotencyTransitionOptions,
  IdempotencyTransitionResult,
  InFlightMode,
  JsonValue,
  KeyDerivationOptions,
} from "./types.js";

const DEFAULT_PREFIX = "idempotency";
const DEFAULT_HASH_ALGORITHM: HashAlgorithm = "sha256";
const DEFAULT_LEASE_SECONDS = 30;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

const isFiniteTtl = (ttlSeconds: number | null | undefined): ttlSeconds is number =>
  typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds) && ttlSeconds > 0;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errorToJson = (error: unknown): JsonValue => {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  if (error === null || typeof error === "string" || typeof error === "number" || typeof error === "boolean") {
    return error;
  }
  try {
    return JSON.parse(JSON.stringify(error)) as JsonValue;
  } catch {
    return String(error);
  }
};

const reconstructError = (json: JsonValue | undefined): Error => {
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const record = json as Record<string, JsonValue>;
    const error = new Error(String(record.message ?? "Idempotent operation previously failed"));
    if (record.name) {
      error.name = String(record.name);
    }
    return error;
  }
  return new Error(typeof json === "string" ? json : "Idempotent operation previously failed");
};

type SettleResult =
  | { readonly kind: "gone" }
  | { readonly kind: "timeout" }
  | { readonly kind: "collision" }
  | { readonly kind: "completed"; readonly record: IdempotencyRecord }
  | { readonly kind: "failed"; readonly record: IdempotencyRecord };

interface DerivedKey {
  readonly id: string;
  readonly key: string;
  readonly payloadHash: string;
  readonly canonicalPayload: string;
  readonly namespace?: string;
}

export class IdempotencyManager {
  private readonly store: IdempotencyStore;
  private readonly keyPrefix: string;
  private readonly namespace?: string;
  private readonly defaultTtlSeconds: number | null;
  private readonly hashAlgorithm: HashAlgorithm;
  private readonly hashFn?: HashFunction;
  private readonly storeCanonicalPayload: boolean;
  private readonly slidingTtl: boolean;
  private readonly events?: IdempotencyEvents;

  constructor(store: IdempotencyStore, options: IdempotencyManagerOptions = {}) {
    if (!store) {
      throw new IdempotencyError("A storage adapter instance is required");
    }

    this.store = store;
    this.keyPrefix = options.keyPrefix?.replace(/:+$/, "") ?? DEFAULT_PREFIX;
    this.namespace = options.namespace;
    const defaultTtl = options.defaultTtlSeconds;
    if (defaultTtl === undefined || defaultTtl === null) {
      this.defaultTtlSeconds = null;
    } else {
      if (!Number.isInteger(defaultTtl) || defaultTtl <= 0) {
        throw new IdempotencyError("defaultTtlSeconds must be a positive integer when provided");
      }
      this.defaultTtlSeconds = defaultTtl;
    }
    this.hashAlgorithm = options.hashAlgorithm ?? DEFAULT_HASH_ALGORITHM;
    this.hashFn = options.hashFn;
    this.storeCanonicalPayload = options.storeCanonicalPayload ?? false;
    this.slidingTtl = options.slidingTtl ?? false;
    this.events = options.events;
  }

  public generateId(payload: unknown, options: KeyDerivationOptions = {}): string {
    if (options.idempotencyKey !== undefined) {
      return options.idempotencyKey;
    }
    return this.hash(canonicalize(projectPayload(payload, options)));
  }

  public buildKey(id: string, namespace: string | undefined = this.namespace): string {
    return namespace ? `${this.keyPrefix}:${namespace}:${id}` : `${this.keyPrefix}:${id}`;
  }

  public async register(
    payload: unknown,
    options: IdempotencyRegisterOptions = {},
  ): Promise<IdempotencyRegistrationResult> {
    const derived = this.derive(payload, options);
    const ttlSeconds = this.resolveTtl(options.ttlSeconds);
    const storeCanonicalPayload = options.storeCanonicalPayload ?? this.storeCanonicalPayload;

    const record: IdempotencyRecord = {
      id: derived.id,
      payloadHash: derived.payloadHash,
      createdAt: new Date().toISOString(),
      status: options.status ?? "completed",
      metadata: options.metadata,
      canonicalPayload: storeCanonicalPayload ? derived.canonicalPayload : undefined,
      result: options.result,
      ttlSeconds,
    };

    const inserted = await this.store.setIfAbsent(derived.key, serializeRecord({ record }), ttlSeconds);
    if (inserted) {
      this.emit("onMiss", { id: derived.id, key: derived.key, namespace: derived.namespace });
      this.emit("onStore", { id: derived.id, key: derived.key, namespace: derived.namespace, record });
      return { id: derived.id, key: derived.key, stored: true, record };
    }

    const existingRecord = await this.readExisting(derived);
    this.emit("onHit", { id: derived.id, key: derived.key, namespace: derived.namespace, record: existingRecord });
    return { id: derived.id, key: derived.key, stored: false, record: existingRecord };
  }

  public async execute<T>(
    payload: unknown,
    operation: () => T | Promise<T>,
    options: IdempotencyExecuteOptions = {},
  ): Promise<IdempotencyExecuteResult<T>> {
    const derived = this.derive(payload, options);
    const finalTtl = this.resolveTtl(options.ttlSeconds);
    const leaseSeconds = this.resolveLease(options.leaseSeconds);
    const inFlight: InFlightMode = options.inFlight ?? "wait";
    const failureMode: FailureMode = options.failureMode ?? "retry";
    const storeResult = options.storeResult ?? true;
    const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const storeCanonicalPayload = options.storeCanonicalPayload ?? this.storeCanonicalPayload;
    const deadline = Date.now() + waitTimeoutMs;

    for (;;) {
      const attemptId = randomUUID();
      const pending: IdempotencyRecord = {
        id: derived.id,
        payloadHash: derived.payloadHash,
        createdAt: new Date().toISOString(),
        status: "pending",
        metadata: options.metadata,
        canonicalPayload: storeCanonicalPayload ? derived.canonicalPayload : undefined,
        attemptId,
        ttlSeconds: finalTtl,
      };

      const inserted = await this.store.setIfAbsent(derived.key, serializeRecord({ record: pending }), leaseSeconds);
      if (inserted) {
        this.emit("onMiss", { id: derived.id, key: derived.key, namespace: derived.namespace });
        return await this.runLeader<T>(derived, pending, attemptId, operation, {
          finalTtl,
          failureMode,
          storeResult,
        });
      }

      const existing = await this.store.get(derived.key);
      if (!existing) {
        if (Date.now() > deadline) {
          throw new IdempotencyInProgressError(derived.id, derived.key, "Timed out acquiring idempotency lease");
        }
        await sleep(pollIntervalMs);
        continue;
      }

      const record = deserializeRecord(existing.value);
      if (record.payloadHash !== derived.payloadHash) {
        this.emit("onCollision", { id: derived.id, key: derived.key, namespace: derived.namespace });
        throw new IdempotencyCollisionError(`Collision detected for key ${derived.key}`);
      }

      const status: IdempotencyStatus = record.status ?? "completed";
      if (status === "completed") {
        this.emit("onHit", { id: derived.id, key: derived.key, namespace: derived.namespace, record });
        return { id: derived.id, key: derived.key, fromCache: true, status: "completed", value: record.result as T, record };
      }
      if (status === "failed") {
        if (failureMode === "cache") {
          this.emit("onHit", { id: derived.id, key: derived.key, namespace: derived.namespace, record });
          throw reconstructError(record.error);
        }
        await this.store.delete(derived.key);
        continue;
      }

      if (inFlight === "fail-fast") {
        throw new IdempotencyInProgressError(derived.id, derived.key);
      }

      const settled = await this.waitForSettle(derived, deadline, pollIntervalMs);
      if (settled.kind === "gone") {
        continue;
      }
      if (settled.kind === "collision") {
        this.emit("onCollision", { id: derived.id, key: derived.key, namespace: derived.namespace });
        throw new IdempotencyCollisionError(`Collision detected for key ${derived.key}`);
      }
      if (settled.kind === "completed") {
        this.emit("onHit", { id: derived.id, key: derived.key, namespace: derived.namespace, record: settled.record });
        return { id: derived.id, key: derived.key, fromCache: true, status: "completed", value: settled.record.result as T, record: settled.record };
      }
      if (settled.kind === "failed") {
        if (failureMode === "cache") {
          throw reconstructError(settled.record.error);
        }
        await this.store.delete(derived.key);
        continue;
      }
      throw new IdempotencyInProgressError(derived.id, derived.key, "Timed out waiting for in-flight operation to complete");
    }
  }

  public async complete(
    id: string,
    result: JsonValue,
    options: IdempotencyTransitionOptions = {},
  ): Promise<IdempotencyTransitionResult> {
    return this.transition(id, options, "completed", { result });
  }

  public async fail(
    id: string,
    error: unknown,
    options: IdempotencyTransitionOptions = {},
  ): Promise<IdempotencyTransitionResult> {
    return this.transition(id, options, "failed", { error: errorToJson(error) });
  }

  public async lookupByPayload(
    payload: unknown,
    options: IdempotencyLookupOptions & KeyDerivationOptions = {},
  ): Promise<IdempotencyLookupResult | null> {
    const id = this.generateId(payload, options);
    return this.lookupById(id, options);
  }

  public async lookupById(id: string, options: IdempotencyLookupOptions = {}): Promise<IdempotencyLookupResult | null> {
    const namespace = options.namespace ?? this.namespace;
    const key = this.buildKey(id, namespace);
    const stored = await this.store.get(key);
    if (!stored) {
      this.emit("onMiss", { id, key, namespace });
      return null;
    }

    const record = deserializeRecord(stored.value);
    let ttlSeconds = stored.ttlSeconds ?? record.ttlSeconds ?? null;

    if ((options.slidingTtl ?? this.slidingTtl) && isFiniteTtl(record.ttlSeconds)) {
      await this.store.update(key, stored.value, record.ttlSeconds);
      ttlSeconds = record.ttlSeconds;
    }

    this.emit("onHit", { id, key, namespace, record });
    return { id, key, record, ttlSeconds };
  }

  public async has(id: string, options: IdempotencyMutateOptions = {}): Promise<boolean> {
    const key = this.buildKey(id, options.namespace ?? this.namespace);
    return (await this.store.get(key)) !== null;
  }

  public async exists(payload: unknown, options: KeyDerivationOptions = {}): Promise<boolean> {
    return this.has(this.generateId(payload, options), options);
  }

  public async registerMany(
    payloads: readonly unknown[],
    options: IdempotencyRegisterOptions = {},
  ): Promise<IdempotencyRegistrationResult[]> {
    return Promise.all(payloads.map((payload) => this.register(payload, options)));
  }

  public async lookupMany(
    ids: readonly string[],
    options: IdempotencyLookupOptions = {},
  ): Promise<(IdempotencyLookupResult | null)[]> {
    return Promise.all(ids.map((id) => this.lookupById(id, options)));
  }

  public async clear(id: string, options: IdempotencyMutateOptions = {}): Promise<boolean> {
    const key = this.buildKey(id, options.namespace ?? this.namespace);
    return this.store.delete(key);
  }

  public async updateTtl(
    id: string,
    ttlSeconds: number | null | undefined,
    options: IdempotencyMutateOptions = {},
  ): Promise<void> {
    const key = this.buildKey(id, options.namespace ?? this.namespace);
    const newTtl = this.resolveTtl(ttlSeconds);

    const stored = await this.store.get(key);
    if (!stored) {
      throw new IdempotencyError(`Cannot update TTL for missing key ${key}`);
    }

    const existingRecord = deserializeRecord(stored.value);
    const recordToStore: IdempotencyRecord = {
      ...existingRecord,
      ttlSeconds: isFiniteTtl(newTtl) ? newTtl : null,
    };
    await this.store.update(key, serializeRecord({ record: recordToStore }), newTtl);
  }

  private derive(payload: unknown, options: KeyDerivationOptions): DerivedKey {
    const canonicalPayload = canonicalize(projectPayload(payload, options));
    const payloadHash = this.hash(canonicalPayload);
    const id = options.idempotencyKey ?? payloadHash;
    const namespace = options.namespace ?? this.namespace;
    const key = this.buildKey(id, namespace);
    return { id, key, payloadHash, canonicalPayload, namespace };
  }

  private hash(canonicalPayload: string): string {
    return this.hashFn ? this.hashFn(canonicalPayload) : hashCanonicalValue(canonicalPayload, this.hashAlgorithm);
  }

  private async readExisting(derived: DerivedKey): Promise<IdempotencyRecord> {
    const existingValue = await this.store.get(derived.key);
    if (!existingValue) {
      throw new IdempotencyError("Failed to persist idempotency record due to concurrent deletion");
    }
    const existingRecord = deserializeRecord(existingValue.value);
    if (existingRecord.payloadHash !== derived.payloadHash) {
      this.emit("onCollision", { id: derived.id, key: derived.key, namespace: derived.namespace });
      throw new IdempotencyCollisionError(`Collision detected for key ${derived.key}`);
    }
    return existingRecord;
  }

  private async runLeader<T>(
    derived: DerivedKey,
    pending: IdempotencyRecord,
    attemptId: string,
    operation: () => T | Promise<T>,
    options: { finalTtl: number | null; failureMode: FailureMode; storeResult: boolean },
  ): Promise<IdempotencyExecuteResult<T>> {
    let value: T;
    try {
      value = await operation();
    } catch (error) {
      if (options.failureMode === "cache") {
        const failed: IdempotencyRecord = {
          ...pending,
          status: "failed",
          error: errorToJson(error),
          updatedAt: new Date().toISOString(),
          ttlSeconds: options.finalTtl,
        };
        await this.commit(derived.key, attemptId, failed, options.finalTtl);
        this.emit("onFail", { id: derived.id, key: derived.key, namespace: derived.namespace, record: failed });
      } else {
        await this.release(derived.key, attemptId);
        this.emit("onFail", { id: derived.id, key: derived.key, namespace: derived.namespace, record: pending });
      }
      throw error;
    }

    const completed: IdempotencyRecord = {
      ...pending,
      status: "completed",
      result: options.storeResult ? (value as unknown as JsonValue) : undefined,
      updatedAt: new Date().toISOString(),
      ttlSeconds: options.finalTtl,
    };
    await this.commit(derived.key, attemptId, completed, options.finalTtl);
    this.emit("onStore", { id: derived.id, key: derived.key, namespace: derived.namespace, record: completed });
    this.emit("onComplete", { id: derived.id, key: derived.key, namespace: derived.namespace, record: completed });
    return { id: derived.id, key: derived.key, fromCache: false, status: "completed", value, record: completed };
  }

  private async commit(
    key: string,
    attemptId: string,
    record: IdempotencyRecord,
    ttlSeconds: number | null,
  ): Promise<void> {
    const current = await this.store.get(key);
    if (!current) {
      return;
    }
    const currentRecord = deserializeRecord(current.value);
    if (currentRecord.attemptId !== attemptId) {
      return;
    }
    await this.store.update(key, serializeRecord({ record }), ttlSeconds);
  }

  private async release(key: string, attemptId: string): Promise<void> {
    const current = await this.store.get(key);
    if (!current) {
      return;
    }
    const currentRecord = deserializeRecord(current.value);
    if (currentRecord.attemptId === attemptId) {
      await this.store.delete(key);
    }
  }

  private async waitForSettle(derived: DerivedKey, deadline: number, pollIntervalMs: number): Promise<SettleResult> {
    for (;;) {
      if (Date.now() > deadline) {
        return { kind: "timeout" };
      }
      await sleep(pollIntervalMs);
      const current = await this.store.get(derived.key);
      if (!current) {
        return { kind: "gone" };
      }
      const record = deserializeRecord(current.value);
      if (record.payloadHash !== derived.payloadHash) {
        return { kind: "collision" };
      }
      const status: IdempotencyStatus = record.status ?? "completed";
      if (status === "completed") {
        return { kind: "completed", record };
      }
      if (status === "failed") {
        return { kind: "failed", record };
      }
    }
  }

  private async transition(
    id: string,
    options: IdempotencyTransitionOptions,
    status: IdempotencyStatus,
    extra: Partial<IdempotencyRecord>,
  ): Promise<IdempotencyTransitionResult> {
    const namespace = options.namespace ?? this.namespace;
    const key = this.buildKey(id, namespace);
    const stored = await this.store.get(key);
    if (!stored) {
      throw new IdempotencyError(`Cannot transition missing key ${key}`);
    }
    const existing = deserializeRecord(stored.value);
    const ttlSeconds =
      options.ttlSeconds === undefined ? stored.ttlSeconds ?? existing.ttlSeconds ?? null : this.resolveTtl(options.ttlSeconds);
    const record: IdempotencyRecord = {
      ...existing,
      ...extra,
      status,
      updatedAt: new Date().toISOString(),
      ttlSeconds,
    };
    await this.store.update(key, serializeRecord({ record }), ttlSeconds);
    const eventName = status === "completed" ? "onComplete" : "onFail";
    this.emit(eventName, { id, key, namespace, record });
    return { id, key, record };
  }

  private emit<K extends keyof IdempotencyEvents>(
    name: K,
    context: Parameters<NonNullable<IdempotencyEvents[K]>>[0],
  ): void {
    const handler = this.events?.[name] as ((value: typeof context) => void) | undefined;
    if (!handler) {
      return;
    }
    try {
      handler(context);
    } catch {
      return;
    }
  }

  private resolveLease(leaseSeconds: number | undefined): number {
    if (leaseSeconds === undefined) {
      return DEFAULT_LEASE_SECONDS;
    }
    if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) {
      throw new IdempotencyError("leaseSeconds must be a positive integer when provided");
    }
    return leaseSeconds;
  }

  private resolveTtl(ttlSeconds: number | null | undefined): number | null {
    if (ttlSeconds === undefined) {
      return this.defaultTtlSeconds;
    }

    if (ttlSeconds === null) {
      return null;
    }

    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0) {
      throw new IdempotencyError("TTL must be a non-negative integer, null, or undefined");
    }

    if (ttlSeconds === 0) {
      return null;
    }

    return ttlSeconds;
  }
}
