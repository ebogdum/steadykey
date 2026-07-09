import { IdempotencyError } from "../errors.js";
import type { IdempotencyStore, IdempotencyStoreValue, MongoCollectionLike } from "../types.js";

interface MongoStoreDocument {
  _id: string;
  value: string;
  expiresAt?: Date | null;
}

interface MongoStoreOptions {
  readonly ensureIndexes?: boolean;
}

const ttlFromDate = (expiresAt?: Date | null): number | null => {
  if (!expiresAt) {
    return null;
  }
  const diff = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  return diff > 0 ? diff : 0;
};

const isDuplicateKeyError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const mongoCode = (error as { code?: number }).code;
  return mongoCode === 11000;
};

export class MongoIdempotencyStore implements IdempotencyStore {
  private readonly ready: Promise<void>;

  constructor(private readonly collection: MongoCollectionLike<MongoStoreDocument>, options: MongoStoreOptions = {}) {
    if (!collection) {
      throw new IdempotencyError("MongoDB collection is required for MongoIdempotencyStore");
    }
    if (options.ensureIndexes === false) {
      this.ready = Promise.resolve();
    } else {
      this.ready = this.collection
        .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
        .then(() => undefined)
        .catch(() => undefined);
    }
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean> {
    await this.ready;
    const now = new Date();
    const expiresAt = typeof ttlSeconds === "number" && ttlSeconds > 0 ? new Date(now.getTime() + ttlSeconds * 1000) : null;
    try {
      const result = await this.collection.updateOne(
        { _id: key, expiresAt: { $lte: now } },
        { $set: { value, expiresAt: expiresAt ?? null } },
        { upsert: true },
      );
      const upserted = (result.upsertedCount ?? (result.upsertedId ? 1 : 0)) > 0;
      return upserted || result.modifiedCount > 0;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return false;
      }
      throw error;
    }
  }

  async get(key: string): Promise<IdempotencyStoreValue | null> {
    await this.ready;
    const document = await this.collection.findOne({ _id: key });
    if (!document) {
      return null;
    }

    if (document.expiresAt && document.expiresAt.getTime() <= Date.now()) {
      await this.collection.deleteOne({ _id: key, expiresAt: { $lte: new Date() } });
      return null;
    }

    return {
      value: document.value,
      ttlSeconds: ttlFromDate(document.expiresAt),
    };
  }

  async update(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    await this.ready;
    const expiresAt = typeof ttlSeconds === "number" && ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000) : null;
    const updateResult = await this.collection.updateOne(
      { _id: key },
      {
        $set: {
          value,
          expiresAt: expiresAt ?? null,
        },
      },
    );

    if (!updateResult || updateResult.matchedCount === 0) {
      throw new IdempotencyError(`Failed to update key ${key} in MongoDB store`);
    }
  }

  async delete(key: string): Promise<boolean> {
    await this.ready;
    const result = await this.collection.deleteOne({ _id: key });
    return Boolean(result.deletedCount && result.deletedCount > 0);
  }
}
