import { IdempotencyError } from "../errors.js";
import { quoteIdentifier, indexBaseName } from "../internal/sql.js";
import { futureEpochSeconds, remainingFromEpoch } from "../internal/time.js";
import type { IdempotencyStore, IdempotencyStoreValue } from "../types.js";

const DEFAULT_TABLE = "steadykey_entries";

interface D1RunResult {
  meta?: { changes?: number };
}

interface D1Row {
  value: string;
  expires_at: number | null;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  run(): Promise<D1RunResult>;
  first<T = unknown>(): Promise<T | null>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  exec(query: string): Promise<unknown>;
}

export interface CloudflareD1StoreOptions {
  readonly tableName?: string;
  readonly ensureTable?: boolean;
}

const nowEpoch = (): number => Math.floor(Date.now() / 1000);

export class CloudflareD1IdempotencyStore implements IdempotencyStore {
  private readonly table: string;
  private readonly indexName: string;
  private readonly ready: Promise<void>;

  constructor(private readonly db: D1DatabaseLike, options: CloudflareD1StoreOptions = {}) {
    if (!db) {
      throw new IdempotencyError("A D1 database binding is required for CloudflareD1IdempotencyStore");
    }
    const rawTable = options.tableName ?? DEFAULT_TABLE;
    this.table = quoteIdentifier(rawTable, '"');
    this.indexName = `${indexBaseName(rawTable)}_expires_at_idx`;
    this.ready = options.ensureTable === false ? Promise.resolve() : this.ensureTable();
  }

  private async ensureTable(): Promise<void> {
    await this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.table} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NULL);`,
    );
    await this.db.exec(`CREATE INDEX IF NOT EXISTS ${this.indexName} ON ${this.table} (expires_at);`);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean> {
    await this.ready;
    const expiresAt = futureEpochSeconds(ttlSeconds);
    const result = await this.db
      .prepare(
        `INSERT INTO ${this.table} (key, value, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
           value = excluded.value,
           expires_at = excluded.expires_at
         WHERE expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .bind(key, value, expiresAt, nowEpoch())
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async get(key: string): Promise<IdempotencyStoreValue | null> {
    await this.ready;
    const row = await this.db
      .prepare(
        `SELECT value, expires_at FROM ${this.table}
         WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
      )
      .bind(key, nowEpoch())
      .first<D1Row>();
    if (!row) {
      return null;
    }
    return { value: row.value, ttlSeconds: remainingFromEpoch(row.expires_at ?? null) };
  }

  async update(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    await this.ready;
    const expiresAt = futureEpochSeconds(ttlSeconds);
    const result = await this.db
      .prepare(`UPDATE ${this.table} SET value = ?, expires_at = ? WHERE key = ?`)
      .bind(value, expiresAt, key)
      .run();
    if ((result.meta?.changes ?? 0) === 0) {
      throw new IdempotencyError(`Failed to update key ${key} in Cloudflare D1 store`);
    }
  }

  async delete(key: string): Promise<boolean> {
    await this.ready;
    const result = await this.db.prepare(`DELETE FROM ${this.table} WHERE key = ?`).bind(key).run();
    return (result.meta?.changes ?? 0) > 0;
  }
}
