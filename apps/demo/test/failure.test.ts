// A chain read the pages make with viem themselves (the postage check's balance and fee cap, a drop's gas estimate, the
// register's head block and log scans) fails the way the SDK's own reads fail: as the CHAIN_UNAVAILABLE slip, which
// offers "Try again", and never as viem's message, which names the RPC URL, the request body with the account's
// address, and viem's version. The failures below are real: viem against a local server that refuses, errs, stalls
// or answers 503.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { registerHooks } from "node:module";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { isLetterlockError, letterlockAbi } from "letterlock";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, createPublicClient, encodeErrorResult, http, type PublicClient } from "viem";

// lib/register.ts reaches the deployment records through lib/chain.ts, and Node loads JSON only with an import
// attribute: here a .json file loads as the module Next.js makes of it (as in test/deployment.test.ts)
registerHooks({
  load: (url, context, nextLoad) =>
    url.startsWith("file:") && url.endsWith(".json")
      ? { format: "module", source: `export default ${readFileSync(new URL(url), "utf8")};`, shortCircuit: true }
      : nextLoad(url, context),
});
const { toFailure, asChainError } = await import("../lib/failure.ts");
const { SLIP_COPY } = await import("../lib/error-copy.ts");
const { readKeyLines } = await import("../lib/register.ts");

const ACCOUNT = "0xe5290000000000000000000000000000000000aA"; // EIP-55 checksummed: viem refuses a mis-cased address

type Mode = "error" | "stall" | "503";
const servers: Server[] = [];
const urls = {} as Record<Mode | "refused", string>;
const listen = async (handler: Parameters<typeof createServer>[1]): Promise<string> => {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/`;
};

before(async () => {
  // a JSON-RPC error: the node answered, and refused
  urls.error = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id } = JSON.parse(body) as { id: number };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "internal error" } }));
    });
  });
  // no answer at all: the request times out
  urls.stall = await listen(() => undefined);
  // a gateway error
  urls["503"] = await listen((_req, res) => {
    res.statusCode = 503;
    res.end("Service Unavailable");
  });
  // a port nothing listens on: fetch fails, as when the browser cannot reach the RPC
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  urls.refused = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/`;
  await new Promise<void>((r) => closed.close(() => r()));
});
after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
});

const client = (url: string): PublicClient => createPublicClient({ transport: http(url, { retryCount: 0, timeout: 400 }) }) as PublicClient;
const caught = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return assert.fail("expected the read to fail");
};

/** nothing of viem's own report reaches the page: not the URL, the request body, the method or viem's version */
const leaks = (value: unknown, url: string) => {
  const text = JSON.stringify(value);
  for (const s of [url.replace(/\/$/, ""), "Request body", "eth_getBalance", "eth_getLogs", "viem@", "HTTP request failed", ACCOUNT])
    assert.ok(!text.includes(s), `the failure shown carries ${JSON.stringify(s)}: ${text}`);
};

for (const mode of ["refused", "error", "stall", "503"] as const) {
  test(`a balance read the page makes itself (${mode}) is the CHAIN_UNAVAILABLE slip, with "Try again", and none of viem's report`, async () => {
    const e = await caught(client(urls[mode]).getBalance({ address: ACCOUNT }));
    assert.equal(isLetterlockError(e), false, "the read failed with viem's own error");
    assert.match(String((e as Error).message), /URL|Request body|Version: viem@/, "viem's report is what the page used to print");
    const f = toFailure(e, { account: ACCOUNT });
    assert.equal(f.kind, "slip", JSON.stringify(f));
    if (f.kind === "slip") assert.equal(f.code, "CHAIN_UNAVAILABLE");
    assert.equal(SLIP_COPY.CHAIN_UNAVAILABLE.action, "Try again");
    // the slip may quote the account the page knew, never viem's text about it
    if (f.kind === "slip") assert.deepEqual(f.values, { account: ACCOUNT });
    leaks(f.kind === "slip" ? { ...f, values: {} } : f, urls[mode]);
  });
}

test("the reads' own wrappers give the SDK's error, and the register's log scan fails as CHAIN_UNAVAILABLE", async () => {
  const wrapped = asChainError(await caught(client(urls.refused).getBlockNumber({ cacheTime: 0 })), "reading the register's head block");
  assert.equal(isLetterlockError(wrapped, "CHAIN_UNAVAILABLE"), true);
  const scan = await caught(readKeyLines({ fromBlock: 1n, toBlock: 50n, client: client(urls.error) }));
  assert.equal(isLetterlockError(scan, "CHAIN_UNAVAILABLE"), true, String(scan));
  const f = toFailure(scan);
  assert.deepEqual(f, { kind: "slip", code: "CHAIN_UNAVAILABLE", values: {} });
  // anything that is not a viem error passes through the wrapper unchanged
  const plain = new Error("not a chain error");
  assert.equal(asChainError(plain, "x"), plain);
});

test("a directory revert in the page's own gas estimate reads as the SDK's code, not as viem's report", () => {
  const revert = (errorName: "NoKeyPublished" | "EnvelopeTooLarge", args: readonly unknown[]) =>
    new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi: letterlockAbi, functionName: "drop", data: encodeErrorResult({ abi: letterlockAbi, errorName, args } as never) }),
      { abi: letterlockAbi, functionName: "drop", args: [], contractAddress: "0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e" },
    );
  const none = toFailure(revert("NoKeyPublished", [ACCOUNT, 0n]));
  assert.deepEqual(none.kind === "slip" && none.code, "NO_KEY_PUBLISHED");
  const big = toFailure(revert("EnvelopeTooLarge", [20_000n, 16_384n]));
  assert.equal(big.kind, "input");
  if (big.kind === "input") {
    assert.match(big.message, /20000 bytes; the directory takes at most 16384 \(EnvelopeTooLarge\)/);
    leaks(big, "https://rpc.monad.xyz/");
  }
});

test("a failure that is not the chain's keeps its own words", () => {
  assert.deepEqual(toFailure(new Error("Passkeys for Letterlock are made only at app.letterlock.edycu.dev")), {
    kind: "message",
    title: "Something went wrong",
    message: "Passkeys for Letterlock are made only at app.letterlock.edycu.dev",
  });
  assert.equal(toFailure(new TypeError("Failed to fetch")).kind, "message");
});
