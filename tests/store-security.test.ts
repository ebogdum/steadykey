import { describe, it, expect } from "vitest";
import {
  MySqlIdempotencyStore,
  PostgresIdempotencyStore,
  SqliteIdempotencyStore,
} from "../src/index.js";
import type { MySqlClientLike, PgClientLike, SqliteDatabaseLike } from "../src/types.js";

const fakeMySql: MySqlClientLike = {
  execute: async () => [{ affectedRows: 0 } as never, null],
};
const fakePg: PgClientLike = {
  query: async () => ({ rowCount: 0, rows: [] }),
};
const fakeSqlite: SqliteDatabaseLike = {
  exec: () => undefined,
  run: () => ({ changes: 0 }),
  get: () => undefined,
};

const INJECTION_TABLE_NAMES = [
  "users; DROP TABLE steadykey_entries",
  'a"; DELETE FROM x; --',
  "a`; DROP TABLE x; --",
  "table name",
  "1abc",
  "",
  "a;b",
  "a(b)",
];

describe("SQL identifier injection guard", () => {
  it("rejects malicious Postgres table names", () => {
    for (const name of INJECTION_TABLE_NAMES) {
      expect(() => new PostgresIdempotencyStore(fakePg, { tableName: name, ensureTable: false })).toThrow();
    }
  });

  it("rejects malicious MySQL table names", () => {
    for (const name of INJECTION_TABLE_NAMES) {
      expect(() => new MySqlIdempotencyStore(fakeMySql, { tableName: name, ensureTable: false })).toThrow();
    }
  });

  it("rejects malicious SQLite table names", () => {
    for (const name of INJECTION_TABLE_NAMES) {
      expect(() => new SqliteIdempotencyStore(fakeSqlite, { tableName: name, ensureTable: false })).toThrow();
    }
  });

  it("accepts valid identifiers including schema-qualified names", () => {
    expect(() => new PostgresIdempotencyStore(fakePg, { tableName: "schema.my_table", ensureTable: false })).not.toThrow();
    expect(() => new MySqlIdempotencyStore(fakeMySql, { tableName: "steadykey_entries", ensureTable: false })).not.toThrow();
    expect(() => new SqliteIdempotencyStore(fakeSqlite, { tableName: "steady$key_v2", ensureTable: false })).not.toThrow();
  });
});

describe("MySQL keyLength injection guard", () => {
  it("rejects non-integer, out-of-range, and non-numeric keyLength values", () => {
    const bad: unknown[] = ["128) STORED, x TEXT); DROP TABLE y;--", 3.5, -1, 0, 65536, 70000, NaN, Infinity];
    for (const value of bad) {
      expect(
        () => new MySqlIdempotencyStore(fakeMySql, { ensureTable: false, keyLength: value as number }),
      ).toThrow();
    }
  });

  it("accepts valid integer key lengths", () => {
    for (const value of [1, 128, 255, 65535]) {
      expect(() => new MySqlIdempotencyStore(fakeMySql, { ensureTable: false, keyLength: value })).not.toThrow();
    }
  });
});
