// The package embeds the deployment records as constants (no file or network access needed to find the directory).
// These tests keep the constants equal to deployments/*.json, and the contract under test equal to the deployed one.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEPLOYMENTS, LETTERLOCK_RP_ID, MAX_ENVELOPE_BYTES, NO_AGENT, VERSION, letterlock, letterlockAbi } from "../src/index.ts";
import { anvil, ctx, noChain, publicClient } from "./anvil/context.ts";

type Record = {
  chainId: number; network: string; address: string; block: number; identityRegistry: string; sameSourceAs: string;
  explorer: { contract: string };
};
const record = (chainId: number): Record =>
  JSON.parse(readFileSync(new URL(`../../../deployments/${chainId}.json`, import.meta.url), "utf8")) as Record;

describe("built-in deployments", () => {
  it.each([["monad", 143], ["monad-testnet", 10143]] as const)("%s matches deployments/%s.json", (chain, chainId) => {
    const r = record(chainId);
    const d = DEPLOYMENTS[chain];
    expect(d.chainId).toBe(r.chainId);
    expect(d.network).toBe(r.network);
    expect(d.directory).toBe(r.address);
    expect(d.deployBlock).toBe(BigInt(r.block));
    expect(d.identityRegistry.toLowerCase()).toBe(r.identityRegistry.toLowerCase());
    expect(r.explorer.contract).toBe(`${d.explorer}/address/${d.directory}`);
  });

  it("a client defaults to the recorded directory of its chain", () => {
    expect(letterlock({ chain: "monad" }).directory).toBe(record(143).address);
    expect(letterlock({ chain: "monad-testnet" }).directory).toBe(record(10143).address);
    expect(letterlock({ chain: "monad" }).chainId).toBe(143);
  });

  it("rejects an unknown chain and a malformed directory as INPUT_INVALID", () => {
    expect(() => letterlock({ chain: "ethereum" as never })).toThrow(/INPUT_INVALID/);
    expect(() => letterlock({ chain: "monad", directory: "0x1234" })).toThrow(/INPUT_INVALID/);
  });

  it("LETTERLOCK_RP_ID is a bare hostname (an rpId has no scheme, port or path)", () => {
    expect(LETTERLOCK_RP_ID).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);
    expect(letterlock({ chain: "monad" }).rpId).toBe(LETTERLOCK_RP_ID);
  });

  it("VERSION is package.json's version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe.skipIf(noChain)("the contract under test", () => {
  it("is compiled from the deployed source: its creation code hashes to the value in deployments/143.json", () => {
    const recorded = /keccak256 (0x[0-9a-f]{64})/.exec(record(143).sameSourceAs)?.[1];
    expect(recorded).toBeDefined();
    expect(ctx.ok && ctx.creationCodeHash).toBe(recorded);
    expect(/keccak256 (0x[0-9a-f]{64})/.exec(record(10143).sameSourceAs)?.[1]).toBe(recorded);
  });

  it("NO_AGENT and MAX_ENVELOPE_BYTES equal the contract's constants", async () => {
    if (!ctx.ok) return;
    const read = (functionName: "NO_AGENT" | "MAX_ENVELOPE_BYTES") =>
      publicClient().readContract({ address: anvil().directory, abi: letterlockAbi, functionName });
    expect(await read("NO_AGENT")).toBe(NO_AGENT);
    expect(await read("MAX_ENVELOPE_BYTES")).toBe(BigInt(MAX_ENVELOPE_BYTES));
  });
});
