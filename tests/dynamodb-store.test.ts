import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DynamoDbIdempotencyStore } from "../src/stores/dynamodb-store.js";
import type { DynamoDbClientLike } from "../src/types.js";

const CONDITIONAL_CHECK_FAILED = "ConditionalCheckFailedException";

class FakeDynamoDbClient implements DynamoDbClientLike {
  private readonly items = new Map<string, Record<string, unknown>>();

  constructor(private readonly partitionKey: string = "key") {}

  async put(params: {
    TableName: string;
    Item: Record<string, unknown>;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
  }): Promise<void> {
    const keyValue = params.Item[this.partitionKey];
    if (typeof keyValue !== "string") {
      throw new Error("partition key must be a string");
    }

    const condition = params.ConditionExpression;
    if (condition?.includes("attribute_not_exists")) {
      const existing = this.items.get(keyValue);
      const allowsExpiredOverwrite = condition.includes("<= :now");
      const now = params.ExpressionAttributeValues?.[":now"];
      const ttlName = params.ExpressionAttributeNames?.["#ttl"] ?? "expiresAt";
      const existingTtl = existing?.[ttlName];
      const expired =
        allowsExpiredOverwrite &&
        typeof existingTtl === "number" &&
        typeof now === "number" &&
        existingTtl <= now;
      if (existing && !expired) {
        const error = new Error(CONDITIONAL_CHECK_FAILED);
        error.name = CONDITIONAL_CHECK_FAILED;
        throw error;
      }
    }

    this.items.set(keyValue, { ...params.Item });
  }

  async get(params: {
    TableName: string;
    Key: Record<string, unknown>;
    ConsistentRead?: boolean;
    ProjectionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
  }): Promise<{ Item?: Record<string, unknown> | undefined }> {
    const keyValue = params.Key[this.partitionKey];
    if (typeof keyValue !== "string") {
      throw new Error("partition key must be provided as string");
    }

    const item = this.items.get(keyValue);
    return { Item: item ? { ...item } : undefined };
  }

  async update(params: {
    TableName: string;
    Key: Record<string, unknown>;
    UpdateExpression: string;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
    ReturnValues?: string;
  }): Promise<void> {
    const keyValue = params.Key[this.partitionKey];
    if (typeof keyValue !== "string") {
      throw new Error("partition key must be provided as string");
    }

    const existing = this.items.get(keyValue);
    if (!existing) {
      if (params.ConditionExpression?.includes("attribute_exists")) {
        const error = new Error(CONDITIONAL_CHECK_FAILED);
        error.name = CONDITIONAL_CHECK_FAILED;
        throw error;
      }
      return;
    }

    const names = params.ExpressionAttributeNames ?? {};
    const values = params.ExpressionAttributeValues ?? {};
    const resolveName = (token: string): string => {
      return token.startsWith("#") ? names[token] ?? token : token;
    };
    const resolveValue = (token: string): unknown => values[token];

    const expression = params.UpdateExpression.trim();
    if (!expression.startsWith("SET ")) {
      throw new Error("Unsupported update expression in fake client");
    }

    const withoutSet = expression.slice(4);
    const [setSectionRaw, removeSectionRaw] = withoutSet.split(" REMOVE ");
    const setSegments = setSectionRaw.split(",").map((segment) => segment.trim()).filter(Boolean);

    for (const segment of setSegments) {
      const [left, right] = segment.split("=").map((part) => part.trim());
      const attributeName = resolveName(left);
      const valueToken = right;
      existing[attributeName] = resolveValue(valueToken);
    }

    if (removeSectionRaw) {
      const removeAttributes = removeSectionRaw.split(",").map((part) => resolveName(part.trim()));
      for (const attribute of removeAttributes) {
        delete existing[attribute];
      }
    }
  }

  async delete(params: {
    TableName: string;
    Key: Record<string, unknown>;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
    ReturnValues?: string;
  }): Promise<{ Attributes?: Record<string, unknown> | undefined }> {
    const keyValue = params.Key[this.partitionKey];
    if (typeof keyValue !== "string") {
      throw new Error("partition key must be provided as string");
    }

    const existing = this.items.get(keyValue);
    if (!existing) {
      if (params.ConditionExpression) {
        const error = new Error(CONDITIONAL_CHECK_FAILED);
        error.name = CONDITIONAL_CHECK_FAILED;
        throw error;
      }
      return {};
    }
    if (params.ConditionExpression?.includes("<= :now")) {
      const now = params.ExpressionAttributeValues?.[":now"];
      const ttlName = params.ExpressionAttributeNames?.["#ttl"] ?? "expiresAt";
      const existingTtl = existing[ttlName];
      const stillExpired = typeof existingTtl === "number" && typeof now === "number" && existingTtl <= now;
      if (!stillExpired) {
        const error = new Error(CONDITIONAL_CHECK_FAILED);
        error.name = CONDITIONAL_CHECK_FAILED;
        throw error;
      }
    }

    this.items.delete(keyValue);
    if (params.ReturnValues === "ALL_OLD") {
      return { Attributes: { ...existing } };
    }
    return {};
  }
}

describe("DynamoDbIdempotencyStore", () => {
  let client: FakeDynamoDbClient;
  let store: DynamoDbIdempotencyStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
    client = new FakeDynamoDbClient();
    store = new DynamoDbIdempotencyStore(client, { tableName: "steadykey" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("performs atomic inserts", async () => {
    const inserted = await store.setIfAbsent("id", "value", 60);
    expect(inserted).toBe(true);

    const duplicate = await store.setIfAbsent("id", "value", 60);
    expect(duplicate).toBe(false);
  });

  it("returns values with TTL and respects expirations", async () => {
    await store.setIfAbsent("id", "value", 60);

    const initial = await store.get("id");
    expect(initial?.value).toBe("value");
    expect(initial?.ttlSeconds).toBe(60);

    vi.advanceTimersByTime(61_000);
    const expired = await store.get("id");
    expect(expired).toBeNull();
  });

  it("updates records and handles TTL removal", async () => {
    await store.setIfAbsent("id", "first", null);

    await store.update("id", "second", 120);
    const updated = await store.get("id");
    expect(updated?.value).toBe("second");
    expect(updated?.ttlSeconds).toBe(120);

    await store.update("id", "persistent", null);
    const persistent = await store.get("id");
    expect(persistent?.value).toBe("persistent");
    expect(persistent?.ttlSeconds).toBeNull();
  });

  it("fails to update missing keys", async () => {
    await expect(store.update("missing", "value", null)).rejects.toThrow(/does not exist/);
  });

  it("deletes records", async () => {
    const absent = await store.delete("missing");
    expect(absent).toBe(false);

    await store.setIfAbsent("id", "value", null);
    const deleted = await store.delete("id");
    expect(deleted).toBe(true);
  });

  it("overwrites an expired item on setIfAbsent (DynamoDB TTL sweeper lag)", async () => {
    const first = await store.setIfAbsent("id", "old", 60);
    expect(first).toBe(true);
    expect(await store.setIfAbsent("id", "new", 60)).toBe(false);
    vi.advanceTimersByTime(61_000);
    const overwrite = await store.setIfAbsent("id", "new", 60);
    expect(overwrite).toBe(true);

    const got = await store.get("id");
    expect(got?.value).toBe("new");
  });

  it("does not overwrite a persistent (no-TTL) item on setIfAbsent", async () => {
    expect(await store.setIfAbsent("id", "persistent", null)).toBe(true);
    vi.advanceTimersByTime(10 * 365 * 24 * 3600 * 1000);
    expect(await store.setIfAbsent("id", "other", 60)).toBe(false);
    const got = await store.get("id");
    expect(got?.value).toBe("persistent");
  });

  it("lazily deletes an expired item on read", async () => {
    await store.setIfAbsent("id", "value", 60);
    vi.advanceTimersByTime(61_000);
    expect(await store.get("id")).toBeNull();
    const raw = await client.get({ TableName: "steadykey", Key: { key: "id" } });
    expect(raw?.Item).toBeUndefined();
  });
});
