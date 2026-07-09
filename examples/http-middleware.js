import http from "node:http";
import { IdempotencyManager, InMemoryIdempotencyStore } from "../dist/index.js";
import { createIdempotencyMiddleware } from "../dist/middleware.js";

const manager = new IdempotencyManager(new InMemoryIdempotencyStore(), { defaultTtlSeconds: 60 });
const middleware = createIdempotencyMiddleware(manager, { ttlSeconds: 60 });

let handlerCalls = 0;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    req.body = raw ? JSON.parse(raw) : null;
    middleware(req, res, () => {
      handlerCalls += 1;
      res.statusCode = 201;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ receiptId: "rcpt_1", handlerCalls }));
    });
  });
});

await new Promise((resolve) => server.listen(0, resolve));
const { port } = server.address();
const url = `http://127.0.0.1:${port}/payments`;

const post = (key) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ amount: 4200 }),
  }).then(async (r) => ({ status: r.status, replayed: r.headers.get("idempotent-replayed"), body: await r.json() }));

console.log("first  :", await post("order-A-1"));
console.log("retry  :", await post("order-A-1"));
console.log("handler ran", handlerCalls, "time(s)");

server.close();
