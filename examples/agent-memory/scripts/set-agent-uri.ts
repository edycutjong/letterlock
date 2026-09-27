#!/usr/bin/env node
// Sets the agent's tokenURI again, from its ERC-8004 owner, so that the registry emits URIUpdated and indexers fetch
// the card again. The card's content changes in place at the same URL; an indexer (trust8004, for one) refetches it
// only on an onchain Registered, MetadataSet or URIUpdated event. Run by the owner's operator. Without --send it only
// simulates, from the owner's address, and needs no key.
//
//   node scripts/set-agent-uri.ts [--agent 10260] [--uri URL]                      simulate: no key, no gas
//   OWNER_PRIVATE_KEY=… node scripts/set-agent-uri.ts [--agent 10260] [--uri URL] --send
//
// --uri defaults to the agent's current tokenURI (the same URL: the event is what matters).
import { DEPLOYMENTS } from "letterlock";
import { createPublicClient, createWalletClient, formatEther, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "viem/chains";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const send = args.includes("--send");
const agentId = BigInt(arg("agent") ?? "10260");
const registry = DEPLOYMENTS.monad.identityRegistry;
const rpc = process.env.MONAD_RPC_URL ?? DEPLOYMENTS.monad.rpcUrl;
const abi = parseAbi([
  "function tokenURI(uint256 agentId) view returns (string)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function setAgentURI(uint256 agentId, string newURI)",
]);
const pub = createPublicClient({ chain: monad, transport: http(rpc) });
const [current, owner] = await Promise.all([
  pub.readContract({ address: registry, abi, functionName: "tokenURI", args: [agentId] }),
  pub.readContract({ address: registry, abi, functionName: "ownerOf", args: [agentId] }),
]);
const uri = arg("uri") ?? current;
const call = { address: registry, abi, functionName: "setAgentURI", args: [agentId, uri] } as const;
const plan = { chain: 143, registry, agentId: agentId.toString(), owner, tokenURI: current, next: uri };

if (!send) {
  await pub.simulateContract({ ...call, account: owner });
  const gas = await pub.estimateContractGas({ ...call, account: owner });
  const { maxFeePerGas } = await pub.estimateFeesPerGas();
  console.log(JSON.stringify({ ...plan, simulated: "ok", gas: Number(gas), atMostMON: formatEther(gas * maxFeePerGas), sent: false, note: "OWNER_PRIVATE_KEY=… and --send to send it" }, null, 2));
} else {
  const key = process.env.OWNER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("OWNER_PRIVATE_KEY must hold the agent owner's key (0x + 64 hex)");
  const account = privateKeyToAccount(key as `0x${string}`);
  if (account.address.toLowerCase() !== owner.toLowerCase()) throw new Error(`agent ${agentId} is owned by ${owner}, not ${account.address}`);
  const { request } = await pub.simulateContract({ ...call, account });
  const hash = await createWalletClient({ account, chain: monad, transport: http(rpc) }).writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(JSON.stringify({ ...plan, sent: true, transactionHash: hash, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), status: receipt.status }, null, 2));
}
