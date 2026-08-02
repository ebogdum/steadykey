// Benchmarks steadykey's hot paths against the built package in `dist/`.
//
// Each case runs in this process but is measured with warmup, repeated samples,
// and a median — and every reported figure is compared against the harness
// floor, so a "difference" smaller than call overhead is reported as noise
// rather than as a win. For A/B work (comparing two implementations) run each
// side in a separate process: JIT state and inline-cache shape leak between
// variants measured in the same one, which silently inverts results.
//
//   npm run bench
import { steadyKey, canonicalize, IdempotencyManager, InMemoryIdempotencyStore } from "../dist/index.js";

const PAYLOAD = {
  orderId: "order-8f3c2e9b",
  customerId: "cust-42",
  currency: "USD",
  amount: 4299,
  items: [
    { sku: "A-1", quantity: 1, unitPrice: 1999, name: "Widget" },
    { sku: "B-9", quantity: 2, unitPrice: 1150, name: "Gadget" },
  ],
  shipping: { line1: "1 Main St", city: "Springfield", postcode: "11111", country: "US" },
  metadata: { source: "web", campaign: "spring", sessionId: "sess-abc123" },
};
const SMALL = { orderId: "order-1", amount: 100 };
const BIG = {
  rows: Array.from({ length: 200 }, (_, i) => ({ id: `row-${i}`, qty: i, sku: `SKU-${i}`, ok: i % 2 === 0 })),
};

let sink = 0;

const measure = (fn, iters) => {
  for (let s = 0; s < 6; s += 1) {
    for (let i = 0; i < iters; i += 1) sink ^= String(fn()).length;
  }
  const samples = [];
  for (let s = 0; s < 15; s += 1) {
    const started = process.hrtime.bigint();
    for (let i = 0; i < iters; i += 1) sink ^= String(fn()).length;
    samples.push(Number(process.hrtime.bigint() - started) / iters);
  }
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1];
};

const floor = measure(() => sink, 200_000);

const manager = new IdempotencyManager(new InMemoryIdempotencyStore(), { defaultTtlSeconds: 60 });
const store = new InMemoryIdempotencyStore();
const HEX_ID = "a".repeat(64);
const KEY = manager.buildKey(HEX_ID);
await store.setIfAbsent(KEY, JSON.stringify({ id: HEX_ID, payloadHash: HEX_ID, createdAt: "" }), 60);

const CASES = [
  ["steadyKey(small payload)", () => steadyKey(SMALL), 20_000],
  ["steadyKey(realistic payload)", () => steadyKey(PAYLOAD), 20_000],
  ["steadyKey(200-row payload)", () => steadyKey(BIG), 2_000],
  ["steadyKey(sha512)", () => steadyKey(PAYLOAD, { hashAlgorithm: "sha512" }), 20_000],
  ["canonicalize(realistic)", () => canonicalize(PAYLOAD), 20_000],
  ["JSON.stringify [lower bound]", () => JSON.stringify(PAYLOAD), 20_000],
  ["manager.generateId(realistic)", () => manager.generateId(PAYLOAD), 20_000],
  ["manager.buildKey(hex id)", () => manager.buildKey(HEX_ID), 200_000],
  ["manager.buildKey(id, namespace)", () => manager.buildKey(HEX_ID, "tenant-a"), 200_000],
  ["generateId(ignoreFields)", () => manager.generateId(PAYLOAD, { ignoreFields: ["metadata.sessionId"] }), 20_000],
];

console.log(`node ${process.version}   harness floor ${floor.toFixed(2)} ns/op\n`);
console.log(`${"operation".padEnd(34)}${"ns/op".padStart(11)}${"ops/sec".padStart(14)}`);
console.log("-".repeat(59));
for (const [name, fn, iters] of CASES) {
  const ns = measure(fn, iters);
  const opsPerSec = Math.round(1e9 / ns).toLocaleString("en-US");
  console.log(`${name.padEnd(34)}${ns.toFixed(1).padStart(11)}${opsPerSec.padStart(14)}`);
}

// Async store round-trip, measured separately since it is await-bound.
const asyncMeasure = async (fn, iters) => {
  for (let i = 0; i < iters; i += 1) sink ^= String(await fn()).length;
  const started = process.hrtime.bigint();
  for (let i = 0; i < iters; i += 1) sink ^= String(await fn()).length;
  return Number(process.hrtime.bigint() - started) / iters;
};

console.log();
const lookup = await asyncMeasure(() => store.get(KEY), 50_000);
const execute = await asyncMeasure(() => manager.execute(PAYLOAD, () => 1), 20_000);
console.log(`${"InMemoryStore.get".padEnd(34)}${lookup.toFixed(1).padStart(11)}${Math.round(1e9 / lookup).toLocaleString("en-US").padStart(14)}`);
console.log(`${"execute() cached replay".padEnd(34)}${execute.toFixed(1).padStart(11)}${Math.round(1e9 / execute).toLocaleString("en-US").padStart(14)}`);

if (sink === 42) console.log("");
