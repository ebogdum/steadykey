import { IdempotencyManager } from "./idempotency-manager.js";
import { IdempotencyCollisionError, IdempotencyInProgressError } from "./errors.js";
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

const installCapture = (res: HttpResponseLike) => {
  const chunks: Buffer[] = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    if (chunk) {
      chunks.push(Buffer.from(chunk as Buffer | string));
    }
    return originalWrite(chunk, ...rest);
  };
  res.end = (chunk?: unknown, ...rest: unknown[]): unknown => {
    if (chunk) {
      chunks.push(Buffer.from(chunk as Buffer | string));
    }
    return originalEnd(chunk, ...rest);
  };

  const contentTypeOf = (): string | undefined => {
    const header = res.getHeader("content-type");
    return typeof header === "string" ? header : undefined;
  };

  return {
    snapshot: (): StoredHttpResponse => ({
      status: res.statusCode,
      body: Buffer.concat(chunks).toString("utf8"),
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
    const capture = installCapture(res);

    const operation = (): Promise<StoredHttpResponse> =>
      new Promise<StoredHttpResponse>((resolve, reject) => {
        let settled = false;
        const finalize = (fromClose: boolean): void => {
          if (settled) {
            return;
          }
          settled = true;
          const snapshot = capture.snapshot();
          if (!fromClose && shouldStore(snapshot)) {
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

  const replay = (reply: FastifyReplyLike, stored: JsonValue): unknown => {
    const response = stored as unknown as StoredHttpResponse;
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
          ttlSeconds: options.ttlSeconds,
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
        return replay(reply, acquired.record.result ?? null);
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
      const stored: StoredHttpResponse = {
        status: reply.statusCode,
        body: typeof payload === "string" ? payload : String(payload ?? ""),
        contentType: typeof contentType === "string" ? contentType : undefined,
      };
      if (shouldStore(stored)) {
        await manager.complete(state.id, stored as unknown as JsonValue, { namespace: state.namespace }).catch(() => undefined);
      } else {
        await manager.clear(state.id, { namespace: state.namespace }).catch(() => undefined);
      }
      return payload;
    });
  };

  (plugin as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")] = true;
  return plugin;
};
