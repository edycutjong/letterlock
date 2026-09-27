import { isMeraError } from "@category-labs/mera";
import {
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  InsufficientFundsError,
} from "viem";
import { LetterlockError } from "./errors.ts";

/**
 * Every failure of a directory call leaves the SDK as a LetterlockError (docs/SPEC.md §5). The directory's custom
 * errors map by name; anything the SDK cannot attribute (a failed RPC, a revert without data, RegistryCallFailed) is
 * CHAIN_UNAVAILABLE: the answer is unknown, and never reads as NO_KEY_PUBLISHED.
 *
 * | Directory error                               | Code              |
 * |-----------------------------------------------|-------------------|
 * | ZeroKey, LowOrderKey, NonCanonicalKey          | INPUT_INVALID     |
 * | EpochNotNext(current, given)                   | EPOCH_MISMATCH    |
 * | AgentPathDisabled, AgentIdReserved             | INPUT_INVALID     |
 * | InvalidRecipient, EmptyEnvelope, EnvelopeTooLarge | INPUT_INVALID  |
 * | RegistryHasNoCode (constructor only)           | INPUT_INVALID     |
 * | NotAgentOwner(agentId, caller)                 | NOT_AGENT_OWNER   |
 * | NoKeyPublished(to, toAgent)                    | NO_KEY_PUBLISHED  |
 * | RegistryCallFailed(agentId), no revert data    | CHAIN_UNAVAILABLE |
 */
/** The first error in `e`'s cause chain (e included) that `match` accepts. */
export const findCause = <T>(e: unknown, match: (x: unknown) => x is T): T | undefined => {
  let x: unknown = e;
  for (let depth = 0; x !== undefined && x !== null && depth < 32; depth++) {
    if (match(x)) return x;
    x = typeof x === "object" && "cause" in x ? (x as { cause?: unknown }).cause : undefined;
  }
  return undefined;
};

/** True when a contract call failed because of what the code at the address answered (a revert, no data, or data that does not decode), not because the RPC failed. */
export const answeredByCode = (e: unknown): boolean =>
  findCause(e, (x): x is Error =>
    x instanceof ContractFunctionRevertedError || x instanceof ContractFunctionZeroDataError ||
    x instanceof AbiDecodingDataSizeTooSmallError || x instanceof AbiDecodingZeroDataError) !== undefined;

export const toLetterlockError = (e: unknown, action: string): LetterlockError => {
  if (e instanceof LetterlockError) return e;
  const find = <T>(match: (x: unknown) => x is T): T | undefined => findCause(e, match);
  const brief = e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : String(e);

  const mera = find((x): x is { code: string; message: string } => isMeraError(x));
  if (mera?.code === "SESSION_ENDED")
    return new LetterlockError("INPUT_INVALID", `${action}: the account's signing session has ended; create the account again`, { cause: e });
  if (mera) return new LetterlockError("INPUT_INVALID", `${action}: ${mera.message}`, { cause: e });

  const reverted = find((x): x is ContractFunctionRevertedError => x instanceof ContractFunctionRevertedError);
  if (reverted) {
    const name = reverted.data?.errorName;
    const args = (reverted.data?.args ?? []) as readonly unknown[];
    const fail = (code: ConstructorParameters<typeof LetterlockError>[0], why: string) =>
      new LetterlockError(code, `${action}: ${why}`, { cause: e });
    switch (name) {
      case "ZeroKey":
        return fail("INPUT_INVALID", "the directory refused the key: it is zero (ZeroKey)");
      case "LowOrderKey":
        return fail("INPUT_INVALID", "the directory refused the key: it is a small-order X25519 point (LowOrderKey)");
      case "NonCanonicalKey":
        return fail("INPUT_INVALID", "the directory refused the key: it is not a canonical X25519 encoding (NonCanonicalKey)");
      case "EpochNotNext":
        return fail("EPOCH_MISMATCH", `the directory is at epoch ${String(args[0])}, so the next key must be epoch ${Number(args[0]) + 1}; this one is epoch ${String(args[1])} (EpochNotNext)`);
      case "AgentPathDisabled":
        return fail("INPUT_INVALID", "this directory has no ERC-8004 registry, so it holds no agent keys (AgentPathDisabled)");
      case "AgentIdReserved":
        return fail("INPUT_INVALID", "agent id 2^256 - 1 is the directory's no-agent marker (AgentIdReserved)");
      case "InvalidRecipient":
        return fail("INPUT_INVALID", "a drop names exactly one recipient: an address, or an agent (InvalidRecipient)");
      case "EmptyEnvelope":
        return fail("INPUT_INVALID", "the envelope is empty (EmptyEnvelope)");
      case "EnvelopeTooLarge":
        return fail("INPUT_INVALID", `the envelope is ${String(args[0])} bytes; the directory takes at most ${String(args[1])} (EnvelopeTooLarge)`);
      case "RegistryHasNoCode":
        return fail("INPUT_INVALID", "the registry address has no code (RegistryHasNoCode)");
      case "NotAgentOwner":
        return fail("NOT_AGENT_OWNER", `${String(args[1])} is not the ERC-8004 owner of agent ${String(args[0])} (NotAgentOwner)`);
      case "NoKeyPublished":
        return fail("NO_KEY_PUBLISHED", "the recipient has no key that resolves now (NoKeyPublished)");
      case "RegistryCallFailed":
        return fail("CHAIN_UNAVAILABLE", `the ERC-8004 registry did not answer for agent ${String(args[0])} (RegistryCallFailed): unknown, not "no key"`);
      default:
        return fail("CHAIN_UNAVAILABLE", `the call reverted ${name ? `with ${name}` : "without a reason"}: unknown, not "no key"`);
    }
  }
  if (find((x): x is ContractFunctionZeroDataError => x instanceof ContractFunctionZeroDataError))
    return new LetterlockError("INPUT_INVALID", `${action}: no Letterlock directory answered at that address on this chain`, { cause: e });
  // viem names the error when the node's wording is the usual one; match the wording too, for nodes that differ:
  // Monad says "Signer had insufficient balance", and its eth_call says "reserve balance violation" for a transaction
  // that exceeds the sender's reserve balance
  if (find((x): x is InsufficientFundsError => x instanceof InsufficientFundsError) || /insufficient (funds|balance)|reserve balance violation/i.test(e instanceof Error ? e.message : String(e)))
    return new LetterlockError("INSUFFICIENT_FUNDS", `${action}: the account cannot pay for gas; send it MON first`, { cause: e });
  return new LetterlockError("CHAIN_UNAVAILABLE", `${action}: ${brief}`, { cause: e });
};
