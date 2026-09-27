// scripts/lib/timing.ts, which decides what scripts/bench.ts may count as a sample. viem's HTTP transport, the one the
// SDK's client uses with its defaults, retries a failed request inside the same call: against an RPC that fails once,
// the call still succeeds, just slower. The bench must not time that call as a sample; timeCall() sees the extra request
// and reports the call as failed instead. A local JSON-RPC server stands in for the endpoint.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createPublicClient, http } from "viem";
import { monad } from "viem/chains";
import { summarize } from "../lib/stats.ts";
import { countRequests, timeCall } from "../lib/timing.ts";

let server: Server;
let url = "";
let failNext = 0;
before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => { body += d.toString(); });
    req.on("end", () => {
      if (failNext > 0) {
        failNext--;
        res.writeHead(500).end("upstream hiccup");
        return;
      }
      const { id } = JSON.parse(body) as { id: number };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x10" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });

const requests = countRequests();

test("a call that made the one request it needs is a sample", async () => {
  const client = createPublicClient({ chain: monad, transport: http(url) });
  const r = await timeCall(requests, 1, () => client.getBlockNumber({ cacheTime: 0 }));
  assert.equal(r.ok, true);
  assert.equal(r.requests, 1);
  if (r.ok) assert.equal(r.value, 16n);
});

test("with viem's default retries a failed request is retried inside the call: the call succeeds, and is not a sample", async () => {
  const client = createPublicClient({ chain: monad, transport: http(url) }); // retryCount 3, as the SDK's client has
  failNext = 1;
  const r = await timeCall(requests, 1, () => client.getBlockNumber({ cacheTime: 0 }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "RETRIED");
    assert.equal(r.requests, 2);
    assert.match(r.message, /2 HTTP request\(s\) where the call makes 1: a request failed and was retried/);
  }
});

test("with retryCount 0 (the bench's own client) the same hiccup is a failed call, with one request", async () => {
  const client = createPublicClient({ chain: monad, transport: http(url, { retryCount: 0 }) });
  failNext = 1;
  const r = await timeCall(requests, 1, () => client.getBlockNumber({ cacheTime: 0 }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.requests, 1);
});

test("a call answered without its request (a cache) is not a sample either", async () => {
  const r = await timeCall(requests, 1, async () => 16n);
  assert.deepEqual([r.ok, r.ok ? "" : r.code], [false, "REQUESTS"]);
});

test("percentiles are nearest-rank samples", () => {
  const s = summarize([5, 1, 4, 2, 3]);
  assert.deepEqual([s.min, s.p50, s.p95, s.p99, s.max, s.mean], [1, 3, 5, 5, 5, 3]);
});
