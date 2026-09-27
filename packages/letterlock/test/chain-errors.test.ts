// toLetterlockError against the real errors viem raises for the real directory bytecode (not hand-built errors):
// every custom error a call can revert with maps to its documented code, and nothing unknown reads as "no key".
import { HttpRequestError, parseAbi, toHex, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { LetterlockError, NO_AGENT, deriveKeyPair, letterlockAbi, toLetterlockError, type ChainErrorCode, type LetterlockErrorCode } from "../src/index.ts";
import { Fault, anvil, ctx, faultyAbi, fundedAccount, newAgentId, noChain, publicClient, sendAs, agentStandIn } from "./anvil/context.ts";

const pub = (b: Uint8Array) => toHex(b);
const valid = pub(deriveKeyPair(new Uint8Array(32).fill(42), 1).publicKey);
const someone = () => privateKeyToAccount(generatePrivateKey()).address;

/** Runs a directory call through viem and maps whatever it throws. */
const mapped = async (call: () => Promise<unknown>): Promise<{ code: LetterlockErrorCode | ChainErrorCode | "no error"; message: string }> => {
  try { await call(); return { code: "no error", message: "" }; }
  catch (e) { const l = toLetterlockError(e, "call"); return { code: l.code, message: l.message }; }
};
const simulate = (address: Address, functionName: string, args: readonly unknown[], account: Address = someone()) =>
  () => publicClient().simulateContract({ address, abi: letterlockAbi, functionName, args, account } as never);

describe.skipIf(noChain)("directory errors → LetterlockError codes", () => {
  const dir = () => (ctx.ok ? ctx.directory : ("0x" as Address));

  it.each([
    ["ZeroKey", () => simulate(dir(), "publish", [pub(new Uint8Array(32)), 1]), "INPUT_INVALID"],
    ["LowOrderKey", () => simulate(dir(), "publish", [pub(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0))), 1]), "INPUT_INVALID"],
    ["NonCanonicalKey", () => simulate(dir(), "publish", [`0x${valid.slice(2, 64)}${(parseInt(valid.slice(64), 16) | 0x80).toString(16)}`, 1]), "INPUT_INVALID"],
    ["EpochNotNext", () => simulate(dir(), "publish", [valid, 2]), "EPOCH_MISMATCH"],
    ["AgentIdReserved", () => simulate(dir(), "publishForAgent", [NO_AGENT, valid, 1]), "INPUT_INVALID"],
    ["NotAgentOwner", () => simulate(dir(), "publishForAgent", [newAgentId(), valid, 1]), "NOT_AGENT_OWNER"],
    ["InvalidRecipient", () => simulate(dir(), "drop", ["0x0000000000000000000000000000000000000000", NO_AGENT, "0x7b7d"]), "INPUT_INVALID"],
    ["EmptyEnvelope", () => simulate(dir(), "drop", [someone(), NO_AGENT, "0x"]), "INPUT_INVALID"],
    ["EnvelopeTooLarge", () => simulate(dir(), "drop", [someone(), NO_AGENT, toHex(new Uint8Array(16 * 1024 + 1).fill(0x7b))]), "INPUT_INVALID"],
    ["NoKeyPublished", () => simulate(dir(), "drop", [someone(), NO_AGENT, "0x7b7d"]), "NO_KEY_PUBLISHED"],
  ] as const)("%s → %s", async (name, call, code) => {
    const r = await mapped(call());
    expect(r.code).toBe(code);
    expect(r.message).toContain(`(${name})`);
  });

  it("AgentPathDisabled → INPUT_INVALID", async () => {
    if (!ctx.ok) return;
    const r = await mapped(simulate(ctx.directoryNoAgents, "publishForAgent", [1n, valid, 1]));
    expect(r).toMatchObject({ code: "INPUT_INVALID" });
    expect(r.message).toContain("(AgentPathDisabled)");
  });

  it("RegistryCallFailed on a read → CHAIN_UNAVAILABLE (unknown, not 'no key')", async () => {
    if (!ctx.ok) return;
    const owner = await fundedAccount("1");
    const id = newAgentId();
    await sendAs(ctx.faultyRegistry, faultyAbi, "mint", [owner.address, id]);
    await (await import("./anvil/context.ts")).client({ directory: ctx.directoryFaulty })
      .publishForAgent({ account: owner, agentId: id, keys: agentStandIn(43, id, 1) });
    await sendAs(ctx.faultyRegistry, faultyAbi, "setFault", [Fault.OtherCustomError]);
    try {
      const r = await mapped(() => publicClient().readContract({ address: anvil().directoryFaulty, abi: letterlockAbi, functionName: "keyOfAgent", args: [id] }));
      expect(r.code).toBe("CHAIN_UNAVAILABLE");
      expect(r.message).toContain("(RegistryCallFailed)");
    } finally {
      await sendAs(ctx.faultyRegistry, faultyAbi, "setFault", [Fault.None]);
    }
  });

  it("a revert without data → CHAIN_UNAVAILABLE", async () => {
    const r = await mapped(() => publicClient().readContract({ address: dir(), abi: parseAbi(["function nope() view returns (uint256)"]), functionName: "nope" }));
    expect(r.code).toBe("CHAIN_UNAVAILABLE");
  });

  it("no code at the address → INPUT_INVALID", async () => {
    const r = await mapped(() => publicClient().readContract({ address: someone(), abi: letterlockAbi, functionName: "keyOf", args: [someone()] }));
    expect(r.code).toBe("INPUT_INVALID");
  });
});

describe("errors that are not the directory's", () => {
  it("a failed HTTP request → CHAIN_UNAVAILABLE", () => {
    expect(toLetterlockError(new HttpRequestError({ url: "http://rpc.invalid", status: 503 }), "call").code).toBe("CHAIN_UNAVAILABLE");
  });

  it("a LetterlockError passes through unchanged", () => {
    const e = new LetterlockError("TAMPERED", "x");
    expect(toLetterlockError(e, "call")).toBe(e);
  });

  it("anything else → CHAIN_UNAVAILABLE, with the original as cause", () => {
    const cause = new Error("socket hang up");
    const e = toLetterlockError(cause, "call");
    expect([e.code, e.cause]).toEqual(["CHAIN_UNAVAILABLE", cause]);
  });
});
