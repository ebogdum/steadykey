import { IdempotencyError } from "../errors.js";
import { quoteIdentifier, indexBaseName } from "../internal/sql.js";
import { futureDate, remainingSeconds } from "../internal/time.js";
import type { IdempotencyStore, IdempotencyStoreValue, PgClientLike } from "../types.js";

interface PostgresStoreOptions {
  readonly tableName?: string;
  readonly ensureTable?: boolean;
}

interface PostgresRow {
  value: string;
  expires_at: string | null;
}

const DEFAULT_TABLE = "steadykey_entries";

const CURRENT_CONDITION = "(expires_at IS NULL OR expires_at > NOW())";

export class PostgresIdempotencyStore implements IdempotencyStore {
  private readonly table: string;
  private readonly ready: Promise<void>;
  private readonly indexName: string;

  constructor(private readonly client: PgClientLike, options: PostgresStoreOptions = {}) {
    if (!client) {
      throw new IdempotencyError("PostgreSQL client instance is required for PostgresIdempotencyStore");
    }

    const rawTable = options.tableName ?? DEFAULT_TABLE;
    this.table = quoteIdentifier(rawTable, '"');
    this.indexName = `${indexBaseName(rawTable)}_expires_at_idx`;

    if (options.ensureTable === false) {
      this.ready = Promise.resolve();
    } else {
      this.ready = this.ensureTable();
    }
  }

  private async ensureTable(): Promise<void> {
    const ddl = `
      CREATE TABLE IF NOT EXISTS ${this.table} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at TIMESTAMPTZ NULL
      );
      CREATE INDEX IF NOT EXISTS "${this.indexName}" ON ${this.table} (expires_at);
    `;
    await this.client.query(ddl);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean> {
    await this.ready;
    const expiresAt = futureDate(ttlSeconds);
    const result = await this.client.query(
      `INSERT INTO ${this.table} (key, value, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         expires_at = EXCLUDED.expires_at
       WHERE ${this.table}.expires_at IS NOT NULL
         AND ${this.table}.expires_at <= NOW()`,
      [key, value, expiresAt],
    );
    return result.rowCount === 1;
  }

  async get(key: string): Promise<IdempotencyStoreValue | null> {
    await this.ready;
    const result = await this.client.query<PostgresRow>(
      `SELECT value, expires_at FROM ${this.table} WHERE key = $1 AND ${CURRENT_CONDITION} LIMIT 1`,
      [key],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
    return { value: row.value, ttlSeconds: remainingSeconds(expiresAt) };
  }

  async update(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    await this.ready;
    const expiresAt = futureDate(ttlSeconds);
    const result = await this.client.query(
      `UPDATE ${this.table}
         SET value = $2,
             expires_at = $3
       WHERE key = $1`,
      [key, value, expiresAt],
    );

    if (result.rowCount === 0) {
      throw new IdempotencyError(`Failed to update key ${key} in Postgres store`);
    }
  }

  async delete(key: string): Promise<boolean> {
    await this.ready;
    const result = await this.client.query(`DELETE FROM ${this.table} WHERE key = $1`, [key]);
    return result.rowCount > 0;
  }
}
