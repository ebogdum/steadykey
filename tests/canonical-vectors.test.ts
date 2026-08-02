import { describe, it, expect } from "vitest";
import { canonicalize, steadyKey } from "../src/index.js";

const VALUES: unknown[] = [
  [null, true, false, 0, -0, 1, -1, 3.14, 1e21, 1e-7],
  ["", "x", "str:x", 'quote"in', "back\\\\slash", "new\nline", "unicode-\u00e9", "emoji-\u{1F389}"],
  { b: 1, a: { d: [1, 2, { z: null }], c: "x" } },
  { "10": "a", "2": "b", foo: "c", "01": "d", "4294967295": "e" },
  { a: 1, b: undefined, c: 3 },
  JSON.parse('{"__proto__":{"admin":true},"amount":100}'),
  [0n, 5n, -5n, 12345678901234567890n],
  [new Date("2020-06-01T12:34:56.789Z"), Buffer.from("hi"), Buffer.alloc(0)],
  new Map<unknown, unknown>([[1, "a"], ["1", "b"], [true, "c"], [{ k: 1 }, "d"]]),
  new Set<unknown>([1, "1", true, null]),
  [{}, [], new Map(), new Set()],
];

/**
 * Golden vectors for the canonical form.
 *
 * A generated key is only useful if it is stable: change the canonical bytes
 * and every record already in a user's store becomes unreachable. These pin the
 * exact output so that a refactor — of the serializer, of key ordering, of
 * string escaping — cannot alter it silently. A failure here is either a real
 * regression or a deliberate, breaking, major-version change.
 */
const VECTORS: { name: string; value: unknown; canonical: string; sha256: string; sha512Prefix: string }[] = [
  {
    name: "scalars",
    canonical: "[null,true,false,0,0,1,-1,3.14,1e+21,1e-7]",
    sha256: "80b626bdacbc2ba307d0aa3411232265824dcb9f75e260ce5efcaece1329b368",
    sha512Prefix: "7fc63876e6bb0923f2b381c9fa91e92b",
  },
  {
    name: "strings",
    canonical: "[\"str:\",\"str:x\",\"str:str:x\",\"str:quote\\\"in\",\"str:back\\\\\\\\slash\",\"str:new\\nline\",\"str:unicode-\u00e9\",\"str:emoji-\ud83c\udf89\"]",
    sha256: "b777f91aef635345c3648c0901260be9ffba83ca475b214f5040f0e4c795f29e",
    sha512Prefix: "f0abe1a212f0405c66be37f7df93eb53",
  },
  {
    name: "nested",
    canonical: "{\"a\":{\"c\":\"str:x\",\"d\":[1,2,{\"z\":null}]},\"b\":1}",
    sha256: "b584a716da0adaae95e96f21ef871c33ae1c5a7639bc6393e7cab0556b5d925f",
    sha512Prefix: "9b09b9a977d044dfd65a2b771a52f032",
  },
  {
    name: "array-index keys",
    canonical: "{\"2\":\"str:b\",\"10\":\"str:a\",\"01\":\"str:d\",\"4294967295\":\"str:e\",\"foo\":\"str:c\"}",
    sha256: "f3dd1ea50a3c0bd12413caaac3e8639f25e4fc186f04dbc64589fb5ea5404898",
    sha512Prefix: "443718f8443269be17ee2984a0c3e2ad",
  },
  {
    name: "undefined dropped",
    canonical: "{\"a\":1,\"c\":3}",
    sha256: "ea89132f027adb270741ddeea16f07ee9921176fcef0ca74c33493f321b98620",
    sha512Prefix: "447eb95113e55e546882c0b6d2f6905d",
  },
  {
    name: "proto key",
    canonical: "{\"__proto__\":{\"admin\":true},\"amount\":100}",
    sha256: "727debc418b81db86967eb42d9eeb248e56c3df3294fd6f6e9df6527e34aa809",
    sha512Prefix: "dc56f9accda16ee63424588686620a8d",
  },
  {
    name: "bigint",
    canonical: "[\"bigint:0\",\"bigint:5\",\"bigint:-5\",\"bigint:12345678901234567890\"]",
    sha256: "542029cbe38fe79998c582bad10314aad19b63fa34f405fda40ff372d958daa6",
    sha512Prefix: "5326cc8492bbb5b79b6ddea1ef0451b1",
  },
  {
    name: "date+buffer",
    canonical: "[\"date:2020-06-01T12:34:56.789Z\",\"buffer:aGk=\",\"buffer:\"]",
    sha256: "758417d71e4be9acb196f95c76a3436a732ac36525e4a0d884fa386568d015de",
    sha512Prefix: "a64a7094cc8e5b7591726f64ca24a15b",
  },
  {
    name: "map",
    canonical: "\"map:[[\\\"\\\\\\\"str:1\\\\\\\"\\\",\\\"str:b\\\"],[\\\"1\\\",\\\"str:a\\\"],[\\\"true\\\",\\\"str:c\\\"],[\\\"{\\\\\\\"k\\\\\\\":1}\\\",\\\"str:d\\\"]]\"",
    sha256: "4e5c939317c5f847b4132d60bd9fb4071ca8f108f6213bcaffd3aa0858980626",
    sha512Prefix: "c8080e5ddac00f407c0bb1de3ddd3e95",
  },
  {
    name: "set",
    canonical: "\"set:[\\\"\\\\\\\"str:1\\\\\\\"\\\",\\\"1\\\",\\\"null\\\",\\\"true\\\"]\"",
    sha256: "da689de04161118df2759b6f0845905e3967efe2f8ed2437ab2564b8062c22a5",
    sha512Prefix: "1f2f8f047be1fe8d1e1784a0f1218e05",
  },
  {
    name: "empty",
    canonical: "[{},[],\"map:[]\",\"set:[]\"]",
    sha256: "a16fbdca8bff0a9633f44534e9f363a7ef23b0d0818719204d61d53cb77e8448",
    sha512Prefix: "114c78e7e77d653b0cce1297f97ee0f7",
  },
].map((vector, index) => ({ ...vector, value: VALUES[index] }));

describe("canonical form is stable", () => {
  for (const vector of VECTORS) {
    it(`pins the canonical bytes for ${vector.name}`, () => {
      expect(canonicalize(vector.value)).toBe(vector.canonical);
    });

    it(`pins the derived key for ${vector.name}`, () => {
      expect(steadyKey(vector.value)).toBe(vector.sha256);
      expect(steadyKey(vector.value, { hashAlgorithm: "sha512" }).slice(0, 32)).toBe(vector.sha512Prefix);
    });
  }
});
