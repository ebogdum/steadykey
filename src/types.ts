export type HashAlgorithm = "sha256" | "sha512";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | { [key: string]: JsonValue } | JsonValue[];

export type IdempotencyMetadata = JsonValue;

export type IdempotencyStatus = "pending" | "completed" | "failed";

export type HashFunction = (canonicalValue: string) => string;

export type InFlightMode = "wait" | "fail-fast";

export type FailureMode = "retry" | "cache";

export interface KeyDerivationOptions {
  readonly namespace?: string;
  readonly idempotencyKey?: string;
  readonly ignoreFields?: readonly string[];
  readonly pickFields?: readonly string[];
}

export interface IdempotencyEventContext {
  readonly id: string;
  readonly key: string;
  readonly namespace?: string;
}

export interface IdempotencyEvents {
  readonly onHit?: (context: IdempotencyEventContext & { record: IdempotencyRecord }) => void;
  readonly onMiss?: (context: IdempotencyEventContext) => void;
  readonly onStore?: (context: IdempotencyEventContext & { record: IdempotencyRecord }) => void;
  readonly onCollision?: (context: IdempotencyEventContext) => void;
  readonly onComplete?: (context: IdempotencyEventContext & { record: IdempotencyRecord }) => void;
  readonly onFail?: (context: IdempotencyEventContext & { record: IdempotencyRecord }) => void;
}

export interface IdempotencyManagerOptions {
  readonly keyPrefix?: string;
  readonly namespace?: string;
  readonly defaultTtlSeconds?: number | null;
  readonly hashAlgorithm?: HashAlgorithm;
  readonly hashFn?: HashFunction;
  readonly storeCanonicalPayload?: boolean;
  readonly slidingTtl?: boolean;
  readonly events?: IdempotencyEvents;
  /**
   * Maximum length, in characters, accepted for the key prefix, a namespace, or
   * an idempotency id. Guards against unbounded client-supplied keys. Defaults
   * to 512.
   */
  readonly maxKeyLength?: number;
}

export interface IdempotencyRegisterOptions extends KeyDerivationOptions {
  readonly ttlSeconds?: number | null;
  readonly metadata?: IdempotencyMetadata;
  readonly storeCanonicalPayload?: boolean;
  readonly status?: IdempotencyStatus;
  readonly result?: JsonValue;
}

export interface IdempotencyExecuteOptions extends KeyDerivationOptions {
  readonly ttlSeconds?: number | null;
  readonly metadata?: IdempotencyMetadata;
  readonly storeCanonicalPayload?: boolean;
  readonly storeResult?: boolean;
  readonly leaseSeconds?: number;
  readonly inFlight?: InFlightMode;
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly failureMode?: FailureMode;
}

export interface IdempotencyRecord {
  readonly id: string;
  readonly payloadHash: string;
  readonly createdAt: string;
  readonly status?: IdempotencyStatus;
  readonly metadata?: IdempotencyMetadata;
  readonly canonicalPayload?: string;
  readonly result?: JsonValue;
  readonly error?: JsonValue;
  readonly attemptId?: string;
  readonly updatedAt?: string;
  readonly ttlSeconds?: number | null;
}

export interface IdempotencyRegistrationResult {
  readonly id: string;
  readonly key: string;
  readonly stored: boolean;
  readonly record: IdempotencyRecord;
}

export interface IdempotencyLookupResult {
  readonly id: string;
  readonly key: string;
  readonly record: IdempotencyRecord;
  readonly ttlSeconds?: number | null;
}

export interface IdempotencyExecuteResult<T> {
  readonly id: string;
  readonly key: string;
  readonly fromCache: boolean;
  readonly status: IdempotencyStatus;
  readonly value: T;
  readonly record: IdempotencyRecord;
}

export interface IdempotencyLookupOptions {
  readonly namespace?: string;
  readonly slidingTtl?: boolean;
}

export interface IdempotencyMutateOptions {
  readonly namespace?: string;
}

export interface IdempotencyTransitionOptions {
  readonly namespace?: string;
  readonly ttlSeconds?: number | null;
}

export interface IdempotencyTransitionResult {
  readonly id: string;
  readonly key: string;
  readonly record: IdempotencyRecord;
}

export interface IdempotencyStoreValue {
  readonly value: string;
  readonly ttlSeconds?: number | null;
}

export interface IdempotencyStore {
  setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean>;
  get(key: string): Promise<IdempotencyStoreValue | null>;
  update(key: string, value: string, ttlSeconds: number | null): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface MemcachedClientLike {
  add(key: string, value: string, lifetime: number, callback: (error: unknown, success: boolean) => void): void;
  set(key: string, value: string, lifetime: number, callback: (error: unknown, success: boolean) => void): void;
  get(key: string, callback: (error: unknown, data: string | undefined | null) => void): void;
  del(key: string, callback: (error: unknown, success: boolean) => void): void;
  touch?(key: string, lifetime: number, callback: (error: unknown, success: boolean) => void): void;
}

export interface PgClientLike {
  query<T = unknown>(text: string, params?: readonly unknown[]): Promise<{ rowCount: number; rows: T[] }>;
}

export interface MySqlClientLike {
  execute<T = unknown>(sql: string, params?: readonly unknown[]): Promise<[T, unknown]>;
}

export interface MongoCollectionLike<TDocument> {
  findOne(filter: Record<string, unknown>): Promise<TDocument | null>;
  insertOne(doc: TDocument): Promise<{ acknowledged: boolean }>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<{
    matchedCount: number;
    modifiedCount: number;
    upsertedCount?: number;
    upsertedId?: unknown;
  }>;
  deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount?: number }>;
  createIndex(keys: Record<string, unknown>, options?: Record<string, unknown>): Promise<string>;
}

export interface SqliteRunResult {
  changes?: number;
}

export interface SqliteDatabaseLike {
  exec(sql: string): void | Promise<void>;
  run(sql: string, params?: readonly unknown[] | Record<string, unknown>): SqliteRunResult | Promise<SqliteRunResult>;
  get<T = unknown>(
    sql: string,
    params?: readonly unknown[] | Record<string, unknown>,
  ): T | undefined | Promise<T | undefined>;
}

export interface DynamoDbClientLike {
  put(params: {
    TableName: string;
    Item: Record<string, unknown>;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
  }): Promise<unknown>;
  get(params: {
    TableName: string;
    Key: Record<string, unknown>;
    ConsistentRead?: boolean;
    ProjectionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
  }): Promise<{ Item?: Record<string, unknown> | undefined } | undefined>;
  update(params: {
    TableName: string;
    Key: Record<string, unknown>;
    UpdateExpression: string;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
    ReturnValues?: string;
  }): Promise<unknown>;
  delete(params: {
    TableName: string;
    Key: Record<string, unknown>;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
    ReturnValues?: string;
  }): Promise<{ Attributes?: Record<string, unknown> | undefined } | undefined>;
}
