import type { IdempotencyStore, IdempotencyStoreValue } from "../types.js";

interface Entry {
  value: string;
  expiresAt: number | null;
}

interface InMemoryStoreOptions {
  readonly now?: () => number;
}

const toExpiryEpoch = (ttlSeconds: number | null, nowMs: number): number | null => {
  if (typeof ttlSeconds === "number" && ttlSeconds > 0) {
    return nowMs + ttlSeconds * 1000;
  }
  return null;
};

/**
 * Lower bound on how many writes pass between full sweeps. Above it the
 * interval scales with the map, so the amortized cost stays at a few entry
 * checks per write no matter how large the store grows.
 */
const MIN_WRITES_BETWEEN_SWEEPS = 256;

/**
 * Longest a swept-out entry may linger while the store is being used. The
 * write-count trigger alone never fires after a burst of traffic goes quiet, so
 * elapsed time is what reclaims a spike's worth of expired entries.
 */
const MAX_MS_BETWEEN_SWEEPS = 30_000;

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly store = new Map<string, Entry>();
  private readonly nowBase: () => number;
  private timeOffset = 0;
  private writesSinceSweep = 0;
  private hasExpiringEntries = false;
  private lastSweepAt: number;

  constructor(options: InMemoryStoreOptions = {}) {
    this.nowBase = options.now ?? (() => Date.now());
    this.lastSweepAt = this.nowBase();
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number | null): Promise<boolean> {
    this.evictIfExpired(key);
    if (this.store.has(key)) {
      return false;
    }
    const nowMs = this.currentTime();
    const expiresAt = toExpiryEpoch(ttlSeconds, nowMs);
    this.store.set(key, { value, expiresAt });
    this.noteWrite(expiresAt);
    return true;
  }

  /**
   * Drops every entry whose TTL has passed and returns how many were removed.
   *
   * Entries are otherwise reclaimed lazily, when their own key is touched, so a
   * long-lived process that writes many short-lived keys and never reads them
   * back would hold them forever. Sweeping happens automatically on an
   * amortized schedule; this exposes it for callers that want to force it.
   */
  purgeExpired(): number {
    const before = this.store.size;
    this.sweep();
    return before - this.store.size;
  }

  /** Number of entries currently held, including any not yet swept. */
  get size(): number {
    return this.store.size;
  }

  async get(key: string): Promise<IdempotencyStoreValue | null> {
    this.maybeSweep();
    this.evictIfExpired(key);
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    return {
      value: entry.value,
      ttlSeconds:
        entry.expiresAt === null ? null : Math.max(0, Math.floor((entry.expiresAt - this.currentTime()) / 1000)),
    };
  }

  async update(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    this.evictIfExpired(key);
    if (!this.store.has(key)) {
      throw new Error(`Key ${key} does not exist in InMemoryIdempotencyStore`);
    }
    const nowMs = this.currentTime();
    const expiresAt = toExpiryEpoch(ttlSeconds, nowMs);
    this.store.set(key, { value, expiresAt });
    this.noteWrite(expiresAt);
  }

  async delete(key: string): Promise<boolean> {
    this.maybeSweep();
    return this.store.delete(key);
  }

  private noteWrite(expiresAt: number | null): void {
    if (expiresAt !== null) {
      this.hasExpiringEntries = true;
    }
    this.writesSinceSweep += 1;
    this.maybeSweep();
  }

  /**
   * Runs a full sweep when either trigger fires: enough writes have piled up
   * (threshold scales with the map, so the amortized cost stays near four entry
   * checks per write at any size), or enough time has passed (which is what
   * reclaims a traffic spike once writes stop). Neither runs until something has
   * actually been stored with a TTL, so a store of persistent entries is never
   * scanned.
   */
  private maybeSweep(): void {
    if (!this.hasExpiringEntries) {
      return;
    }
    const dueByWrites = this.writesSinceSweep >= Math.max(MIN_WRITES_BETWEEN_SWEEPS, this.store.size / 4);
    const dueByTime = this.currentTime() - this.lastSweepAt >= MAX_MS_BETWEEN_SWEEPS;
    if (!dueByWrites && !dueByTime) {
      return;
    }
    this.sweep();
  }

  private sweep(): void {
    this.writesSinceSweep = 0;
    this.lastSweepAt = this.currentTime();
    this.purgeExpiredEntries();
  }

  advanceTime(milliseconds: number): void {
    if (milliseconds <= 0) {
      return;
    }
    this.timeOffset += milliseconds;
    this.sweep();
  }

  private evictIfExpired(key: string): void {
    const entry = this.store.get(key);
    if (!entry) {
      return;
    }
    if (entry.expiresAt !== null && entry.expiresAt <= this.currentTime()) {
      this.store.delete(key);
    }
  }

  private currentTime(): number {
    return this.nowBase() + this.timeOffset;
  }

  private purgeExpiredEntries(): void {
    const now = this.currentTime();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }
}
