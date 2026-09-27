// Read-only checks against the live Monad RPCs, run only with LIVE=1 (`pnpm test:live`): no transaction, no key.
// Expected values come from deployments/143.json and deployments/10143.json, the records of the deploy smoke tests.
import { readFileSync } from "node:fs";
import { createPublicClient, http, keccak256 } from "viem";
import { monad } from "viem/chains";
import { describe, expect, it } from "vitest";
import { DEPLOYMENTS, LETTERLOCK_RP_ID, isLetterlockError, letterlock } from "../src/index.ts";
import { anvil, noChain, publicClient } from "./anvil/context.ts";

const live = process.env.LIVE === "1";
type Smoke = { publishedKey: string; epoch: number; kid: string; updatedAt: number; agentKey?: { agentId: number; publishedKey: string; epoch: number; kid: string; updatedAt: number }; dropBlock: number; envelopeBytes: number };
type Rec = { address: string; deployer: string; dropTx: string; smokeTest: Smoke };
const record = (chainId: number) => JSON.parse(readFileSync(new URL(`../../../deployments/${chainId}.json`, import.meta.url), "utf8")) as Rec;

describe.skipIf(!live)("live Monad mainnet (LIVE=1, read-only)", () => {
  const r = record(143);
  const ll = letterlock({ chain: "monad" });

  it("resolve(deployer) returns the smoke test's DEMO KEY from one keyOf read", async () => {
    const key = await ll.resolve(r.deployer);
    expect([`0x${Buffer.from(key.publicKey).toString("hex")}`, key.epoch, key.kid, key.updatedAt]).toEqual([r.smokeTest.publishedKey, r.smokeTest.epoch, r.smokeTest.kid, r.smokeTest.updatedAt]);
  });

  it("resolve('agent:10260') returns the agent's DEMO KEY through the live ERC-8004 registry", async () => {
    const a = r.smokeTest.agentKey!;
    const key = await ll.resolve(`agent:${a.agentId}`);
    expect([`0x${Buffer.from(key.publicKey).toString("hex")}`, key.epoch, key.kid, key.updatedAt]).toEqual([a.publishedKey, a.epoch, a.kid, a.updatedAt]);
  });

  it("resolve('agent:10260') through rpc-mainnet.monadinfra.com, which refuses JSON-RPC batches with HTTP 403", async () => {
    const a = r.smokeTest.agentKey!;
    const key = await letterlock({ chain: "monad", rpcUrl: "https://rpc-mainnet.monadinfra.com" }).resolve(`agent:${a.agentId}`);
    expect([`0x${Buffer.from(key.publicKey).toString("hex")}`, key.epoch]).toEqual([a.publishedKey, a.epoch]);
  });

  it("inbox(deployer) at the drop block finds the smoke test's envelope", async () => {
    const box = await ll.inbox(r.deployer, { fromBlock: r.smokeTest.dropBlock, toBlock: r.smokeTest.dropBlock });
    expect(box.envelopes.map((e) => [e.transactionHash, e.bytes, e.envelope.kid])).toEqual([[r.dropTx, r.smokeTest.envelopeBytes, r.smokeTest.kid]]);
  });

  it("the testnet directory's address on mainnet (no code there) → INPUT_INVALID, not an empty inbox", async () => {
    const other = letterlock({ chain: "monad", directory: DEPLOYMENTS["monad-testnet"].directory });
    const e = await other.inbox(r.deployer, { fromBlock: r.smokeTest.dropBlock, toBlock: r.smokeTest.dropBlock }).then(() => null, (x: unknown) => x);
    expect(isLetterlockError(e, "INPUT_INVALID"), String(e)).toBe(true);
  });

  it.skipIf(noChain)("the mainnet directory runs the bytecode the anvil tests run", async () => {
    const mainnet = createPublicClient({ chain: monad, transport: http() });
    const code = await mainnet.getCode({ address: r.address as `0x${string}` });
    const local = await publicClient().getCode({ address: anvil().directory });
    expect(keccak256(code!)).toBe(keccak256(local!));
  });
});

// The names the docs point at, as the README describes them. A failure here means a name was taken: by the owner
// (update the README, then this check) or by someone else (a squatter: see docs/SPEC.md §6 for the rpId's host).
describe.skipIf(!live)("names the docs point at (LIVE=1, read-only)", () => {
  it("npm has no package named letterlock yet, as the README says", async () => {
    const r = await fetch("https://registry.npmjs.org/letterlock");
    expect(r.status, "the npm name letterlock is taken now: if the owner published it, restore npx in the README").toBe(404);
  });

  it(`nothing is deployed at the pinned rpId's host (${LETTERLOCK_RP_ID}) yet, as the README says`, async () => {
    const r = await fetch(`https://${LETTERLOCK_RP_ID}/`, { redirect: "manual" });
    expect([r.status, r.headers.get("x-vercel-error")], "something is served at the rpId's host now: whose is it?").toEqual([404, "DEPLOYMENT_NOT_FOUND"]);
  });
});

describe.skipIf(!live)("live Monad testnet (LIVE=1, read-only)", () => {
  it("resolve(deployer) returns the smoke test's TEST KEY", async () => {
    const r = record(10143);
    const key = await letterlock({ chain: "monad-testnet" }).resolve(r.deployer);
    expect([`0x${Buffer.from(key.publicKey).toString("hex")}`, key.epoch, key.kid, key.updatedAt]).toEqual([r.smokeTest.publishedKey, r.smokeTest.epoch, r.smokeTest.kid, r.smokeTest.updatedAt]);
  });
});
