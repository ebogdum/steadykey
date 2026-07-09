import { IdempotencyManager, InMemoryIdempotencyStore } from "../dist/index.js";

const manager = new IdempotencyManager(new InMemoryIdempotencyStore(), { defaultTtlSeconds: 60 });

let charges = 0;
const charge = async (order) => {
  charges += 1;
  return { receiptId: `rcpt_${order.id}`, charged: order.amount };
};

const order = { id: "A-1", amount: 4200 };

const first = await manager.execute(order, () => charge(order));
console.log("first call:", first.value, "fromCache:", first.fromCache);

const retry = await manager.execute(order, () => charge(order));
console.log("retry call:", retry.value, "fromCache:", retry.fromCache);

console.log("charge() actually ran", charges, "time(s)");

const [a, b, c] = await Promise.all([
  manager.execute(order, () => charge(order)),
  manager.execute(order, () => charge(order)),
  manager.execute(order, () => charge(order)),
]);
console.log("concurrent duplicates all returned the same receipt:", a.value.receiptId === b.value.receiptId && b.value.receiptId === c.value.receiptId);
console.log("total charge() runs after concurrency:", charges);
