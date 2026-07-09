import { describe, it, expect } from "vitest";
import { canonicalize, steadyKey } from "../src/index.js";
import { IdempotencySerializationError } from "../src/errors.js";

describe("canonicalize / steadyKey injectivity", () => {
  it("does not collide a BigInt with its tagged-string representation", () => {
    expect(steadyKey(5n)).not.toBe(steadyKey("bigint:5"));
  });

  it("does not collide a Buffer with its tagged-string representation", () => {
    const buf = Buffer.from("hello");
    expect(steadyKey(buf)).not.toBe(steadyKey(`buffer:${buf.toString("base64")}`));
  });

  it("does not collide a Map with an array of its token strings", () => {
    expect(steadyKey(new Map([["a", 1]]))).not.toBe(steadyKey(['map:[["a",1]]']));
  });

  it("does not collide a Set with an array of its token strings", () => {
    expect(steadyKey(new Set([1]))).not.toBe(steadyKey(["set:1"]));
  });

  it("does not collide a Date with its ISO string", () => {
    const d = new Date("2020-01-01T00:00:00.000Z");
    expect(steadyKey(d)).not.toBe(steadyKey(d.toISOString()));
  });

  it("keeps all of a set of ambiguous scalars distinct", () => {
    const values: unknown[] = [null, true, false, 0, "", "null", "0", 5n, "5", "true"];
    const ids = values.map((v) => steadyKey(v));
    expect(new Set(ids).size).toBe(values.length);
  });
});

describe("canonicalize prototype-key safety", () => {
  it("does not drop an own __proto__ key (idempotency-bypass collision)", () => {
    const withProto = JSON.parse('{"__proto__": {"admin": true}, "amount": 100}');
    const without = JSON.parse('{"amount": 100}');
    expect(steadyKey(withProto)).not.toBe(steadyKey(without));
    expect(canonicalize(withProto)).toContain("__proto__");
  });

  it("does not drop a nested own __proto__ key", () => {
    const a = JSON.parse('{"a": {"__proto__": {"y": 1}, "keep": 2}}');
    const b = JSON.parse('{"a": {"keep": 2}}');
    expect(steadyKey(a)).not.toBe(steadyKey(b));
  });

  it("does not pollute the global Object prototype", () => {
    canonicalize(JSON.parse('{"__proto__": {"polluted": "yes"}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("canonicalize non-finite and invalid values", () => {
  it("rejects NaN instead of silently collapsing to null", () => {
    expect(() => canonicalize(NaN)).toThrow(IdempotencySerializationError);
  });

  it("rejects Infinity and -Infinity", () => {
    expect(() => canonicalize(Infinity)).toThrow(IdempotencySerializationError);
    expect(() => canonicalize(-Infinity)).toThrow(IdempotencySerializationError);
  });

  it("rejects an invalid Date", () => {
    expect(() => canonicalize(new Date("not-a-date"))).toThrow();
  });
});

describe("canonicalize determinism", () => {
  it("is order-independent for object keys", () => {
    expect(steadyKey({ a: 1, b: 2, c: 3 })).toBe(steadyKey({ c: 3, b: 2, a: 1 }));
  });

  it("is order-independent for Map keys", () => {
    expect(steadyKey(new Map([["b", 2], ["a", 1]]))).toBe(steadyKey(new Map([["a", 1], ["b", 2]])));
  });

  it("is order-independent for Set members", () => {
    expect(steadyKey(new Set([3, 1, 2]))).toBe(steadyKey(new Set([2, 3, 1])));
  });

  it("ignores undefined object properties", () => {
    expect(steadyKey({ a: 1, b: undefined })).toBe(steadyKey({ a: 1 }));
  });

  it("orders non-ASCII keys by code unit, not locale", () => {
    const id1 = steadyKey({ "Z": 1, "a": 2, "Ä": 3 });
    const id2 = steadyKey({ "Ä": 3, "a": 2, "Z": 1 });
    expect(id1).toBe(id2);
  });

  it("produces a hex digest of the expected length per algorithm", () => {
    expect(steadyKey({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(steadyKey({ a: 1 }, { hashAlgorithm: "sha512" })).toMatch(/^[0-9a-f]{128}$/);
  });
});
