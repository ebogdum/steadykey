import { IdempotencyError } from "../errors.js";
import { quoteIdentifier } from "../internal/sql.js";
import { futureDate, remainingSeconds } from "../internal/time.js";
import type { IdempotencyStore, IdempotencyStoreValue, MySqlClientLike } from "../types.js";

interface MySqlStoreOptions {
  readonly tableName?: string;
  readonly ensureTable?: boolean;
  readonly keyLength?: number;
}

interface MySqlRow {
  value: string;
  expires_at: Date | string | null;
}

interface MySqlResult {
  affectedRows?: number;
}

const DEFAULT_TABLE = "steadykey_entries";
const DEFAULT_KEY_LENGTH = 128;

const resolveKeyLength = (keyLength: number | undefined): number => {
  if (keyLength === undefined) {
    return DEFAULT_KEY_LENGTH;
  }
  if (!Number.isInteger(keyLength) || keyLength < 1 || keyLength > 65535) {
    throw new IdempotencyError("keyLength must be an integer between 1 and 65535");
  }
  return keyLength;
};

const toDate = (value: Date | string | null | undefined): Date | null => {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  return new Date(value);
};

const CURRENT_CONDITION = "(`expires_at` IS NULL OR `expires_at` > ?)";
const EXPIRED_PREDICATE = "`expires_at` IS NOT NULL AND `expires_at` <= ?";

export class MySqlIdempotencyStore implements IdempotencyStore {
  private readonly table: string;
  private readonly ready: Promise<void>;
  private readonly keyLength: number;

  constructor(private readonly client: MySqlClientLike, options: MySqlStoreOptions = {}) {
    if (!client) {
      throw new IdempotencyError("MySQL client instance is required for MySqlIdempotencyStore");
    }
    this.keyLength = resolveKeyLength(options.keyLength);
    const rawTable = options.tableName ?? DEFAULT_TABLE;
    this.table = quoteIdentifier(rawTable, "`");
    if (options.ensureTable === false) {
      this.ready = Promise.resolve();
    } else {
      this.ready = this.ensureTable();
    }
  }

  private async ensureTable(): Promise<void> {
    const ddl = `
      CREATE TABLE IF NOT EXISTS ${this.table} (
        \`key\` VARCHAR(${this.keyLength}) PRIMARY KEY,
        \`value\` TEXT NOT NULL,
        \`expires_at\` DATETIME NULL,
        INDEX \`steadykey_expires_at_idx\` (\`expires_at\`)
      ) ENGINE=InnoDB;
    `;
    await this.client.execute(ddl);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean> {
    await this.ready;
    const expiresAt = futureDate(ttlSeconds);
    await this.client.execute<MySqlResult>(
      `DELETE FROM ${this.table} WHERE \`key\` = ? AND ${EXPIRED_PREDICATE}`,
      [key, new Date()],
    );
    const [result] = await this.client.execute<MySqlResult>(
      `INSERT IGNORE INTO ${this.table} (\`key\`, \`value\`, \`expires_at\`)
       VALUES (?, ?, ?)`,
      [key, value, expiresAt],
    );
    return (result as MySqlResult).affectedRows === 1;
  }

  async get(key: string): Promise<IdempotencyStoreValue | null> {
    await this.ready;
    const [rows] = await this.client.execute<MySqlRow[]>(
      `SELECT \`value\`, \`expires_at\` FROM ${this.table} WHERE \`key\` = ? AND ${CURRENT_CONDITION} LIMIT 1`,
      [key, new Date()],
    );

    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) {
      return null;
    }

    return {
      value: row.value,
      ttlSeconds: remainingSeconds(toDate(row.expires_at)),
    };
  }

  async update(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    await this.ready;
    const expiresAt = futureDate(ttlSeconds);
    const [result] = await this.client.execute<MySqlResult>(
      `UPDATE ${this.table}
         SET \`value\` = ?,
             \`expires_at\` = ?
       WHERE \`key\` = ?`,
      [value, expiresAt, key],
    );

    if (!result || (result as MySqlResult).affectedRows === 0) {
      throw new IdempotencyError(`Failed to update key ${key} in MySQL store`);
    }
  }

  async delete(key: string): Promise<boolean> {
    await this.ready;
    const [result] = await this.client.execute<MySqlResult>(
      `DELETE FROM ${this.table} WHERE \`key\` = ?`,
      [key],
    );
    return Boolean((result as MySqlResult).affectedRows && (result as MySqlResult).affectedRows! > 0);
  }
}
