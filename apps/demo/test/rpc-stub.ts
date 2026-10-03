// A stand-in for the chain's JSON-RPC endpoints, for tests that read or write through viem without a network. viem's
// http transport calls the global fetch on every request, so replacing fetch answers every client the modules under
// test made at import. Not a test file itself (the runner takes test/*.test.ts).
import { numberToHex } from "viem";

export type RpcCall = { readonly url: string; readonly method: string; readonly params: readonly unknown[] };
/** Answers one call: the result, or `undefined` for a JSON-RPC error (an RPC that does not hold the block, say). */
export type RpcHandler = (params: readonly unknown[], url: string) => unknown;

export const hex = (n: bigint | number): `0x${string}` => numberToHex(n);

/** A block as eth_getBlockByNumber answers it, with the fields viem formats. */
export const block = (number: bigint, timestamp: bigint, baseFeePerGas = 100n) => ({
  number: hex(number),
  timestamp: hex(timestamp),
  hash: `0x${number.toString(16).padStart(64, "0")}`,
  parentHash: `0x${"00".repeat(32)}`,
  baseFeePerGas: hex(baseFeePerGas),
  gasLimit: hex(30_000_000n),
  gasUsed: "0x0",
  transactions: [],
});

/**
 * Replaces fetch with the stub. Calls to a method with no handler fail the request, so a test learns of any read it did
 * not expect. Returns every call made, in order, and a restore function.
 */
export const stubRpc = (handlers: Record<string, RpcHandler>) => {
  const calls: RpcCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input).replace(/\/+$/, ""); // as the clients were given it
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[];
    const answer = (r: { id: number; method: string; params?: unknown[] }) => {
      const params = r.params ?? [];
      calls.push({ url, method: r.method, params });
      const h = handlers[r.method];
      const result = h ? h(params, url) : undefined;
      return result === undefined
        ? { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: h ? "missing trie node" : `no stub for ${r.method}` } }
        : { jsonrpc: "2.0", id: r.id, result };
    };
    const out = Array.isArray(body) ? body.map(answer) : answer(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = realFetch) };
};
