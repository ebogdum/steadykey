import { IdempotencyError } from "../errors.js";
import type { DynamoDbClientLike, IdempotencyStore, IdempotencyStoreValue } from "../types.js";

interface DynamoDbIdempotencyStoreOptions {
  readonly tableName: string;
  readonly partitionKey?: string;
  readonly valueAttribute?: string;
  readonly ttlAttribute?: string;
  readonly consistentRead?: boolean;
}

const DEFAULT_PARTITION_KEY = "key";
const DEFAULT_VALUE_ATTRIBUTE = "value";
const DEFAULT_TTL_ATTRIBUTE = "expiresAt";
const CONDITIONAL_CHECK_FAILED = "ConditionalCheckFailedException";

const epochSecondsFromTtl = (ttlSeconds: number | null): number | null => {
  if (typeof ttlSeconds === "number" && ttlSeconds > 0) {
    return Math.floor(Date.now() / 1000) + ttlSeconds;
  }
  return null;
};

const ttlFromEpochSeconds = (epochSeconds: number | null | undefined): number | null => {
  if (typeof epochSeconds !== "number") {
    return null;
  }
  const remaining = epochSeconds - Math.floor(Date.now() / 1000);
  if (remaining <= 0) {
    return 0;
  }
  return remaining;
};

const isConditionalCheckFailed = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: string; code?: string }).name ?? (error as { code?: string }).code;
  return name === CONDITIONAL_CHECK_FAILED;
};

const wrapError = (message: string, error: unknown): IdempotencyError => {
  if (error instanceof IdempotencyError) {
    return error;
  }
  const details = error instanceof Error ? `: ${error.message}` : "";
  return new IdempotencyError(`${message}${details}`);
};

export class DynamoDbIdempotencyStore implements IdempotencyStore {
  private readonly tableName: string;
  private readonly partitionKey: string;
  private readonly valueAttribute: string;
  private readonly ttlAttribute: string;
  private readonly consistentRead: boolean;

  constructor(private readonly client: DynamoDbClientLike, options: DynamoDbIdempotencyStoreOptions) {
    if (!client) {
      throw new IdempotencyError("DynamoDB client instance is required for DynamoDbIdempotencyStore");
    }
    if (!options || !options.tableName) {
      throw new IdempotencyError("tableName is required for DynamoDbIdempotencyStore");
    }

    this.tableName = options.tableName;
    this.partitionKey = options.partitionKey ?? DEFAULT_PARTITION_KEY;
    this.valueAttribute = options.valueAttribute ?? DEFAULT_VALUE_ATTRIBUTE;
    this.ttlAttribute = options.ttlAttribute ?? DEFAULT_TTL_ATTRIBUTE;
    this.consistentRead = options.consistentRead ?? true;
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean> {
    const ttlEpoch = epochSecondsFromTtl(ttlSeconds);
    const item: Record<string, unknown> = {
      [this.partitionKey]: key,
      [this.valueAttribute]: value,
    };
    if (ttlEpoch !== null) {
      item[this.ttlAttribute] = ttlEpoch;
    }

    const nowEpoch = Math.floor(Date.now() / 1000);
    try {
      await this.client.put({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(#pk) OR #ttl <= :now",
        ExpressionAttributeNames: {
          "#pk": this.partitionKey,
          "#ttl": this.ttlAttribute,
        },
        ExpressionAttributeValues: {
          ":now": nowEpoch,
        },
      });
      return true;
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        return false;
      }
      throw wrapError(`Failed to persist key ${key} in DynamoDB store`, error);
    }
  }

  async get(key: string): Promise<IdempotencyStoreValue | null> {
    const response = await this.client.get({
      TableName: this.tableName,
      Key: {
        [this.partitionKey]: key,
      },
      ConsistentRead: this.consistentRead,
    });

    const item = response?.Item;
    if (!item) {
      return null;
    }

    const rawValue = item[this.valueAttribute];
    if (typeof rawValue !== "string") {
      throw new IdempotencyError(`Stored value for key ${key} in DynamoDB must be a string`);
    }

    const ttlEpochRaw = item[this.ttlAttribute];
    if (ttlEpochRaw !== undefined && ttlEpochRaw !== null && typeof ttlEpochRaw !== "number") {
      throw new IdempotencyError(`TTL attribute for key ${key} in DynamoDB must be a number when present`);
    }

    const ttlSeconds = ttlFromEpochSeconds(ttlEpochRaw ?? null);
    if (ttlSeconds === 0) {
      try {
        await this.client.delete({
          TableName: this.tableName,
          Key: {
            [this.partitionKey]: key,
          },
          ConditionExpression: "#ttl <= :now",
          ExpressionAttributeNames: {
            "#ttl": this.ttlAttribute,
          },
          ExpressionAttributeValues: {
            ":now": Math.floor(Date.now() / 1000),
          },
        });
      } catch {
        return null;
      }
      return null;
    }

    return {
      value: rawValue,
      ttlSeconds,
    };
  }

  async update(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    const ttlEpoch = epochSecondsFromTtl(ttlSeconds);

    let updateExpression = "SET #value = :value";
    const expressionAttributeNames: Record<string, string> = {
      "#value": this.valueAttribute,
      "#pk": this.partitionKey,
    };
    const expressionAttributeValues: Record<string, unknown> = {
      ":value": value,
    };

    if (ttlEpoch !== null) {
      expressionAttributeNames["#ttl"] = this.ttlAttribute;
      expressionAttributeValues[":ttl"] = ttlEpoch;
      updateExpression += ", #ttl = :ttl";
    } else {
      expressionAttributeNames["#ttl"] = this.ttlAttribute;
      updateExpression += " REMOVE #ttl";
    }

    try {
      await this.client.update({
        TableName: this.tableName,
        Key: {
          [this.partitionKey]: key,
        },
        UpdateExpression: updateExpression,
        ConditionExpression: "attribute_exists(#pk)",
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      });
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        throw new IdempotencyError(`Failed to update key ${key} in DynamoDB store: key does not exist`);
      }
      throw wrapError(`Failed to update key ${key} in DynamoDB store`, error);
    }
  }

  async delete(key: string): Promise<boolean> {
    const response = await this.client.delete({
      TableName: this.tableName,
      Key: {
        [this.partitionKey]: key,
      },
      ReturnValues: "ALL_OLD",
    });
    return Boolean(response?.Attributes);
  }
}
