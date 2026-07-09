export class IdempotencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyError";
  }
}

export class IdempotencyCollisionError extends IdempotencyError {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyCollisionError";
  }
}

export class IdempotencySerializationError extends IdempotencyError {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencySerializationError";
  }
}

export class IdempotencyInProgressError extends IdempotencyError {
  public readonly id: string;
  public readonly key: string;

  constructor(id: string, key: string, message?: string) {
    super(message ?? `Operation for key ${key} is already in progress`);
    this.name = "IdempotencyInProgressError";
    this.id = id;
    this.key = key;
  }
}
