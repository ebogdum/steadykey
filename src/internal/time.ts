export const futureDate = (ttlSeconds: number | null): Date | null =>
  typeof ttlSeconds === "number" && ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000) : null;

export const remainingSeconds = (expiresAt: Date | null): number | null => {
  if (!expiresAt) {
    return null;
  }
  const remaining = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  return remaining > 0 ? remaining : 0;
};

export const futureEpochSeconds = (ttlSeconds: number | null): number | null =>
  typeof ttlSeconds === "number" && ttlSeconds > 0 ? Math.floor((Date.now() + ttlSeconds * 1000) / 1000) : null;

export const remainingFromEpoch = (epochSeconds: number | null): number | null => {
  if (epochSeconds === null) {
    return null;
  }
  const remaining = epochSeconds - Math.floor(Date.now() / 1000);
  return remaining > 0 ? remaining : 0;
};

export const isPromise = <T>(value: T | Promise<T>): value is Promise<T> =>
  typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";

export const maybeAwait = async <T>(value: T | Promise<T>): Promise<T> => (isPromise(value) ? value : value);
