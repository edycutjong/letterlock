// inbox(): Dropped logs, read in pages the RPC accepts. Monad's public RPCs cap eth_getLogs ranges (rpc.monad.xyz
// answered "-32614 eth_getLogs is limited to a 100 range" for 1,000 blocks on 2026-09-27; rpc3 "Block range is too
// large"; rpc-mainnet.monadinfra.com "block range too large"). A proxy in front of anvil reproduces each refusal.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { toHex, type Address } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { NO_AGENT, deriveKeyPair, isLetterlockError, letterlockAbi, seal, type Envelope } from "../src/index.ts";
import { narrowRange } from "../src/inbox.ts";
import { anvil, client, ctx, fundedAccount, noChain, publicClient, sendAs, testClient } from "./anvil/context.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("narrowRange", () => {
  it("uses the limit the RPC names", () => {
    expect(narrowRange(10_000, "eth_getLogs is limited to a 100 range")).toBe(100);
    expect(narrowRange(10_000, "query exceeds max block range 1000")).toBe(1000);
    expect(narrowRange(10_000, "block range is limited to 2000 blocks: max 2000 blocks")).toBe(2000);
  });
  it("otherwise takes a tenth, down to 1", () => {
    expect(narrowRange(10_000, "Block range is too large")).toBe(1000);
    expect(narrowRange(5, "block range too large")).toBe(1);
    expect(narrowRange(100, "eth_getLogs is limited to a 500 range")).toBe(10); // a named limit above the range is no help
  });
});

type Refusal = { readonly code: number; readonly message: (limit: number) => string };
const REFUSALS: Record<string, Refusal> = {
  "rpc.monad.xyz (QuickNode)": { code: -32614, message: (n) => `eth_getLogs is limited to a ${n} range` },
  "rpc3.monad.xyz (Ankr)": { code: -32062, message: () => "Block range is too large" },
  "rpc-mainnet.monadinfra.com": { code: -32602, message: () => "block range too large" },
};

/** Forwards JSON-RPC to anvil, refusing eth_getLogs over `limit` blocks the way the named RPC does. */
const rangeLimitedProxy = async (upstream: string, limit: number, refusal: Refusal) => {
  const stats = { getLogs: 0, refused: 0 };
  const forward = async (req: { id: unknown; method: string; params: unknown[] }) => {
    if (req.method === "eth_getLogs") {
      stats.getLogs++;
      const f = req.params[0] as { fromBlock: string; toBlock: string };
      if (BigInt(f.toBlock) - BigInt(f.fromBlock) >= BigInt(limit)) {
        stats.refused++;
        return { jsonrpc: "2.0", id: req.id, error: { code: refusal.code, message: refusal.message(limit) } };
      }
    }
    const r = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
    return r.json();
  };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", async () => {
      const parsed = JSON.parse(body) as unknown;
      const reply = Array.isArray(parsed) ? await Promise.all(parsed.map(forward)) : await forward(parsed as never);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, stats, close: () => new Promise((r) => server.close(r)) };
};

describe.skipIf(noChain)("inbox", () => {
  let recipient: Address;
  let keys: ReturnType<typeof deriveKeyPair>;
  let first: bigint;
  const sent: string[] = [];
  let last: bigint;

  beforeAll(async () => {
    if (!ctx.ok) return;
    const account = await fundedAccount();
    recipient = account.address;
    keys = deriveKeyPair(new Uint8Array(32).fill(77), 1);
    first = (await client().publish({ account, keys })).blockNumber;
    const sender = await fundedAccount();
    for (const [i, note] of ["one", "two", "three"].entries()) {
      if (i > 0) await testClient().mine({ blocks: 150 }); // spread the drops over more than one page
      sent.push((await client().drop({ account: sender, envelope: await client().sealTo(recipient, utf8(note)) })).transactionHash);
    }
    last = await publicClient().getBlockNumber();
  });

  it("returns every drop for the recipient, oldest first", async () => {
    const r = await client().inbox(recipient, { fromBlock: first });
    expect(r.envelopes.map((e) => e.transactionHash)).toEqual(sent);
    expect(r.rejected).toEqual([]);
    expect(r.recipient).toBe(recipient.toLowerCase());
    expect(r.toBlock).toBeGreaterThanOrEqual(last);
  });

  it("defaults to the directory's deploy block", async () => {
    const r = await client().inbox(recipient);
    expect(r.fromBlock).toBe(BigInt(ctx.ok ? ctx.deployBlock : 0));
    expect(r.envelopes).toHaveLength(3);
  });

  it("pages of 1 block return the same envelopes, one request per block", async () => {
    const r = await client().inbox(recipient, { fromBlock: first, toBlock: last, blockRange: 1 });
    expect(r.envelopes.map((e) => e.transactionHash)).toEqual(sent);
    expect(r.requests).toBe(Number(last - first + 1n));
  });

  it("a toBlock before the drops returns none; one past the head is clamped to the head", async () => {
    expect((await client().inbox(recipient, { fromBlock: first, toBlock: first })).envelopes).toEqual([]);
    const r = await client().inbox(recipient, { fromBlock: first, toBlock: last + 1_000_000n });
    expect(r.toBlock).toBeLessThan(last + 1_000_000n);
    expect(r.envelopes).toHaveLength(3);
  });

  it.each(Object.entries(REFUSALS))("an RPC that refuses wide ranges like %s: the scan narrows and misses nothing", async (_, refusal) => {
    const proxy = await rangeLimitedProxy(ctx.ok ? ctx.rpcUrl : "", 100, refusal);
    try {
      const r = await client({ rpcUrl: proxy.url }).inbox(recipient, { fromBlock: first });
      expect(r.envelopes.map((e) => e.transactionHash)).toEqual(sent);
      expect(r.blockRange).toBeLessThanOrEqual(100);
      expect(proxy.stats.refused).toBeGreaterThan(0);
      expect(r.requests).toBe(proxy.stats.getLogs);
    } finally { await proxy.close(); }
  });

  it("any drop that is not an envelope for this recipient is listed as rejected, with the reason", async () => {
    if (!ctx.ok) return;
    const account = await fundedAccount();
    const other = await fundedAccount();
    await client().publish({ account, keys: deriveKeyPair(new Uint8Array(32).fill(78), 1) });
    await client().publish({ account: other, keys: deriveKeyPair(new Uint8Array(32).fill(79), 1) });
    const from = await publicClient().getBlockNumber();
    const raw = (bytes: Uint8Array) => sendAs(anvil().directory, letterlockAbi, "drop", [account.address, NO_AGENT, toHex(bytes)]);
    const forOther: Envelope = await client().sealTo(other.address, utf8("not for you"));
    const elsewhere = await seal({ chainId: 10143, directory: ctx.directory, to: { recipient: account.address, publicKey: deriveKeyPair(new Uint8Array(32).fill(78), 1).publicKey, epoch: 1 }, plaintext: utf8("x") });
    await raw(utf8("hello, not JSON"));
    await raw(utf8(JSON.stringify(forOther)));
    await raw(utf8(JSON.stringify(elsewhere)));
    await raw(utf8(JSON.stringify({ ...forOther, recipient: account.address.toLowerCase(), ct: "not base64!" })));
    const good = await client().drop({ account: other, envelope: await client().sealTo(account.address, utf8("for you")) });
    const r = await client().inbox(account.address, { fromBlock: from });
    expect(r.envelopes.map((e) => e.transactionHash)).toEqual([good.transactionHash]);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      "envelope is not JSON",
      `sealed to ${other.address.toLowerCase()}`,
      "sealed for chain 10143",
      "envelope fields are not canonical base64url",
    ]);
  });

  it("agent:<id> recipients read the (address(0), agentId) topic", async () => {
    const r = await client().inbox(`agent:${123456789}`, { fromBlock: first });
    expect(r.envelopes).toEqual([]);
    expect(r.recipient).toBe("agent:123456789");
  });

  it("bad input → INPUT_INVALID; an RPC that does not answer → CHAIN_UNAVAILABLE", async () => {
    const code = (p: Promise<unknown>) => p.then(() => "no error", (e: unknown) => (isLetterlockError(e) ? e.code : String(e)));
    expect(await code(client().inbox("maya.eth"))).toBe("INPUT_INVALID");
    expect(await code(client().inbox(recipient, { blockRange: 0 }))).toBe("INPUT_INVALID");
    expect(await code(client({ deployBlock: undefined, directory: "0x000000000000000000000000000000000000bEEF" }).inbox(recipient))).toBe("INPUT_INVALID");
    expect(await code(client({ rpcUrl: "http://127.0.0.1:9" }).inbox(recipient, { fromBlock: 1n }))).toBe("CHAIN_UNAVAILABLE");
  });
});

