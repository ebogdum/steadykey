import { IdempotencyManager } from "./idempotency-manager.js";
import { IdempotencyCollisionError, IdempotencyError, IdempotencyInProgressError } from "./errors.js";
import type { IdempotencyExecuteOptions, JsonValue } from "./types.js";

export interface StoredHttpResponse {
  readonly status: number;
  readonly body: string;
  readonly contentType?: string;
}

export interface IdempotencyMiddlewareOptions {
  readonly headerName?: string;
  readonly required?: boolean;
  readonly methods?: readonly string[];
  readonly ttlSeconds?: number | null;
  readonly namespace?: string | ((request: HttpRequestLike) => string | undefined);
  readonly fingerprint?: (request: HttpRequestLike) => unknown;
  readonly shouldStore?: (response: StoredHttpResponse) => boolean;
  readonly replayHeader?: string;
  readonly execute?: Partial<IdempotencyExecuteOptions>;
  /**
   * Maximum response body size, in bytes, that will be buffered and cached.
   * A response that grows past this limit is streamed through untouched and is
   * never stored, so a large or streaming endpoint cannot be used to exhaust
   * process memory or the backing store. Defaults to 1 MiB.
   */
  readonly maxBodyBytes?: number;
  /**
   * Lifetime of the `pending` placeholder record written before the handler
   * runs (Fastify plugin only). Bounds how long a key stays locked if the
   * connection is aborted or the process dies mid-request. Defaults to 30s.
   */
  readonly leaseSeconds?: number;
}

export interface HttpRequestLike {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface HttpResponseLike {
  statusCode: number;
  headersSent: boolean;
  write(chunk: unknown, ...rest: unknown[]): boolean;
  end(chunk?: unknown, ...rest: unknown[]): unknown;
  setHeader(name: string, value: string): void;
  getHeader(name: string): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export type NextFunction = (error?: unknown) => void;

const DEFAULT_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
const DEFAULT_HEADER = "idempotency-key";
const DEFAULT_REPLAY_HEADER = "idempotent-replayed";
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_LEASE_SECONDS = 30;

const resolveMaxBodyBytes = (maxBodyBytes: number | undefined): number => {
  if (maxBodyBytes === undefined) {
    return DEFAULT_MAX_BODY_BYTES;
  }
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new IdempotencyError("maxBodyBytes must be a positive integer when provided");
  }
  return maxBodyBytes;
};

const resolveLeaseSeconds = (leaseSeconds: number | undefined): number => {
  if (leaseSeconds === undefined) {
    return DEFAULT_LEASE_SECONDS;
  }
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new IdempotencyError("leaseSeconds must be a positive integer when provided");
  }
  return leaseSeconds;
};

/**
 * A cached record is only replayed if it really is a captured HTTP response.
 * Anything else (a record written through another code path that shares the key
 * space, or a corrupted entry) is ignored rather than turned into a malformed
 * reply.
 */
const isStoredHttpResponse = (value: unknown): value is StoredHttpResponse => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.status === "number" &&
    Number.isInteger(candidate.status) &&
    candidate.status >= 100 &&
    candidate.status <= 599 &&
    typeof candidate.body === "string" &&
    (candidate.contentType === undefined || typeof candidate.contentType === "string")
  );
};

/**
 * A captured body is stored as a UTF-8 string. Bytes that are not valid UTF-8 —
 * an image, a gzip frame — do not survive that round trip, so a response
 * carrying them must not be cached rather than be replayed corrupted.
 *
 * A strict decoder answers this in one pass, without materializing a second
 * copy of the body just to compare against.
 */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

const isLosslessUtf8 = (raw: Buffer): boolean => {
  try {
    strictUtf8.decode(raw);
    return true;
  } catch {
    return false;
  }
};

class NonCacheableResponse extends Error {
  constructor(public readonly response: StoredHttpResponse) {
    super("non-cacheable response");
    this.name = "NonCacheableResponse";
  }
}

const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const resolveNamespace = (
  option: IdempotencyMiddlewareOptions["namespace"],
  request: HttpRequestLike,
): string | undefined => (typeof option === "function" ? option(request) : option);

const installCapture = (res: HttpResponseLike, maxBodyBytes: number) => {
  let chunks: Buffer[] = [];
  let bufferedBytes = 0;
  /** Set when the body can no longer be stored faithfully: too large, or not encodable. */
  let uncacheable = false;
  let joined: Buffer | null = null;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  const abandon = (): void => {
    uncacheable = true;
    chunks = [];
    bufferedBytes = 0;
    joined = null;
  };

  const buffer = (chunk: unknown, rest: unknown[]): void => {
    if (!chunk || uncacheable) {
      return;
    }
    let encoded: Buffer;
    try {
      if (typeof chunk === "string") {
        // `res.write(chunk, encoding)` — reading a string as UTF-8 regardless of
        // the encoding it was written with would corrupt the captured copy. The
        // second argument may also be a callback, or an encoding this runtime
        // does not know.
        const candidate = rest[0];
        const encoding: BufferEncoding =
          typeof candidate === "string" && Buffer.isEncoding(candidate) ? (candidate as BufferEncoding) : "utf8";
        encoded = Buffer.from(chunk, encoding);
      } else {
        encoded = Buffer.from(chunk as Buffer);
      }
    } catch {
      // Capturing must never break the response it is observing; give up on
      // caching this one instead.
      abandon();
      return;
    }
    if (bufferedBytes + encoded.length > maxBodyBytes) {
      // Past the cap, drop what we hold so an oversized body cannot pin memory
      // for the life of the request.
      abandon();
      return;
    }
    chunks.push(encoded);
    bufferedBytes += encoded.length;
  };

  res.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    buffer(chunk, rest);
    return originalWrite(chunk, ...rest);
  };
  res.end = (chunk?: unknown, ...rest: unknown[]): unknown => {
    buffer(chunk, rest);
    return originalEnd(chunk, ...rest);
  };

  const contentTypeOf = (): string | undefined => {
    const header = res.getHeader("content-type");
    return typeof header === "string" ? header : undefined;
  };

  /** Concatenated once, then reused by both the cacheability check and the snapshot. */
  const body = (): Buffer => {
    joined ??= Buffer.concat(chunks);
    return joined;
  };

  return {
    isCacheable: (): boolean => !uncacheable && isLosslessUtf8(body()),
    snapshot: (): StoredHttpResponse => ({
      status: res.statusCode,
      body: body().toString("utf8"),
      contentType: contentTypeOf(),
    }),
    replay: (stored: StoredHttpResponse, replayHeader: string): void => {
      res.statusCode = stored.status;
      if (stored.contentType) {
        res.setHeader("content-type", stored.contentType);
      }
      res.setHeader(replayHeader, "true");
      originalEnd(stored.body);
    },
  };
};

export const createIdempotencyMiddleware = (
  manager: IdempotencyManager,
  options: IdempotencyMiddlewareOptions = {},
) => {
  const headerName = (options.headerName ?? DEFAULT_HEADER).toLowerCase();
  const methods = new Set((options.methods ?? DEFAULT_METHODS).map((method) => method.toUpperCase()));
  const shouldStore = options.shouldStore ?? ((response: StoredHttpResponse) => response.status < 500);
  const replayHeader = options.replayHeader ?? DEFAULT_REPLAY_HEADER;
  const maxBodyBytes = resolveMaxBodyBytes(options.maxBodyBytes);

  return async (req: HttpRequestLike, res: HttpResponseLike, next: NextFunction): Promise<void> => {
    if (!methods.has((req.method ?? "GET").toUpperCase())) {
      next();
      return;
    }

    const key = firstHeader(req.headers[headerName]);
    if (!key) {
      if (options.required) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: `Missing ${headerName} header` }));
        return;
      }
      next();
      return;
    }

    const fingerprint = options.fingerprint ? options.fingerprint(req) : req.body ?? null;
    const namespace = resolveNamespace(options.namespace, req);
    const capture = installCapture(res, maxBodyBytes);

    const operation = (): Promise<StoredHttpResponse> =>
      new Promise<StoredHttpResponse>((resolve, reject) => {
        let settled = false;
        const finalize = (fromClose: boolean): void => {
          if (settled) {
            return;
          }
          settled = true;
          const snapshot = capture.snapshot();
          if (!fromClose && capture.isCacheable() && shouldStore(snapshot)) {
            resolve(snapshot);
          } else {
            reject(new NonCacheableResponse(snapshot));
          }
        };
        res.on("finish", () => finalize(false));
        res.on("close", () => finalize(true));
        try {
          next();
        } catch (error) {
          if (!settled) {
            settled = true;
            reject(error);
          }
        }
      });

    try {
      const result = await manager.execute<StoredHttpResponse>(fingerprint, operation, {
        idempotencyKey: key,
        namespace,
        ttlSeconds: options.ttlSeconds,
        ...options.execute,
      });
      if (result.fromCache) {
        if (!isStoredHttpResponse(result.value)) {
          // The stored record is not a captured response; run the handler
          // rather than emitting a malformed reply from it.
          next();
          return;
        }
        capture.replay(result.value, replayHeader);
      }
    } catch (error) {
      if (error instanceof NonCacheableResponse) {
        return;
      }
      if (res.headersSent) {
        return;
      }
      if (error instanceof IdempotencyInProgressError) {
        res.statusCode = 409;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "A request with this idempotency key is already in progress" }));
        return;
      }
      if (error instanceof IdempotencyCollisionError) {
        res.statusCode = 422;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Idempotency key was reused with a different request body" }));
        return;
      }
      next(error);
    }
  };
};

export interface FastifyRequestLike {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  [key: symbol]: unknown;
}

export interface FastifyReplyLike {
  statusCode: number;
  code(status: number): FastifyReplyLike;
  header(name: string, value: string): FastifyReplyLike;
  getHeader(name: string): unknown;
  send(payload: unknown): unknown;
}

export interface FastifyInstanceLike {
  addHook(name: "preHandler", handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<unknown>): void;
  addHook(
    name: "onSend",
    handler: (request: FastifyRequestLike, reply: FastifyReplyLike, payload: unknown) => Promise<unknown>,
  ): void;
}

const STATE = Symbol("steadykey.idempotency.state");

/** The payload as a storable UTF-8 string, or `null` if it cannot be stored faithfully. */
const cacheableBody = (payload: unknown): string | null => {
  if (typeof payload === "string") {
    return payload;
  }
  if (payload === null || payload === undefined) {
    return "";
  }
  if (Buffer.isBuffer(payload)) {
    return isLosslessUtf8(payload) ? payload.toString("utf8") : null;
  }
  return null;
};

/**
 * The TTL a completed record should carry, replacing the short lease used for
 * the pending placeholder.
 */
const resolveFinalTtl = (
  manager: IdempotencyManager,
  options: IdempotencyMiddlewareOptions,
): number | null => (options.ttlSeconds === undefined ? manager.getDefaultTtlSeconds() : options.ttlSeconds);

interface FastifyState {
  readonly id: string;
  readonly namespace?: string;
  acquired: boolean;
}

export const fastifyIdempotency = (manager: IdempotencyManager, options: IdempotencyMiddlewareOptions = {}) => {
  const headerName = (options.headerName ?? DEFAULT_HEADER).toLowerCase();
  const methods = new Set((options.methods ?? DEFAULT_METHODS).map((method) => method.toUpperCase()));
  const shouldStore = options.shouldStore ?? ((response: StoredHttpResponse) => response.status < 500);
  const replayHeader = options.replayHeader ?? DEFAULT_REPLAY_HEADER;
  const maxBodyBytes = resolveMaxBodyBytes(options.maxBodyBytes);
  const leaseSeconds = resolveLeaseSeconds(options.leaseSeconds);
  const finalTtl = resolveFinalTtl(manager, options);

  const replay = (reply: FastifyReplyLike, response: StoredHttpResponse): unknown => {
    reply.code(response.status);
    if (response.contentType) {
      reply.header("content-type", response.contentType);
    }
    reply.header(replayHeader, "true");
    return reply.send(response.body);
  };

  const plugin = async function plugin(fastify: FastifyInstanceLike): Promise<void> {
    fastify.addHook("preHandler", async (request, reply) => {
      if (!methods.has((request.method ?? "GET").toUpperCase())) {
        return undefined;
      }
      const key = firstHeader(request.headers[headerName]);
      if (!key) {
        if (options.required) {
          reply.code(400);
          return reply.send({ error: `Missing ${headerName} header` });
        }
        return undefined;
      }

      const fingerprint = options.fingerprint ? options.fingerprint(request) : request.body ?? null;
      const namespace = resolveNamespace(options.namespace, request);

      let acquired;
      try {
        acquired = await manager.register(fingerprint, {
          idempotencyKey: key,
          namespace,
          status: "pending",
          // The placeholder only holds the key until `onSend` writes the real
          // record. A short lease keeps an aborted or crashed request from
          // locking the key — and filling the store — indefinitely.
          ttlSeconds: leaseSeconds,
        });
      } catch (error) {
        if (error instanceof IdempotencyCollisionError) {
          reply.code(422);
          return reply.send({ error: "Idempotency key was reused with a different request body" });
        }
        throw error;
      }

      if (acquired.stored) {
        request[STATE] = { id: acquired.id, namespace, acquired: true } satisfies FastifyState;
        return undefined;
      }

      const status = acquired.record.status ?? "completed";
      if (status === "completed") {
        if (isStoredHttpResponse(acquired.record.result)) {
          return replay(reply, acquired.record.result);
        }
        // Not a captured response — fall through and run the handler normally.
        return undefined;
      }
      if (status === "failed") {
        await manager.clear(acquired.id, { namespace });
        reply.code(409);
        return reply.send({ error: "Previous attempt failed; retry the request" });
      }
      reply.code(409);
      return reply.send({ error: "A request with this idempotency key is already in progress" });
    });

    fastify.addHook("onSend", async (request, reply, payload) => {
      const state = request[STATE] as FastifyState | undefined;
      if (!state?.acquired) {
        return payload;
      }
      const contentType = reply.getHeader("content-type");
      // Anything that is not a string or a lossless-UTF-8 buffer — a stream, an
      // image — cannot be stored faithfully, and `String(payload)` would cache
      // "[object Object]" and replay that to every duplicate.
      const body = cacheableBody(payload);
      const stored: StoredHttpResponse = {
        status: reply.statusCode,
        body: body ?? "",
        contentType: typeof contentType === "string" ? contentType : undefined,
      };
      const withinLimit = body !== null && Buffer.byteLength(body, "utf8") <= maxBodyBytes;
      if (withinLimit && shouldStore(stored)) {
        await manager
          .complete(state.id, stored as unknown as JsonValue, {
            namespace: state.namespace,
            ttlSeconds: finalTtl,
          })
          .catch(() => undefined);
      } else {
        await manager.clear(state.id, { namespace: state.namespace }).catch(() => undefined);
      }
      return payload;
    });
  };

  (plugin as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")] = true;
  return plugin;
};
