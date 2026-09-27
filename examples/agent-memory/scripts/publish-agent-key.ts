#!/usr/bin/env node
// Publishes the agent's next key, derived from its seed (src/agent-key.ts), with publishForAgent from the agent's
// ERC-8004 owner. Run by the owner's operator, once per rotation. Without --send it only simulates (no gas).
//
//   LETTERLOCK_AGENT_KEY_SEED=… OWNER_PRIVATE_KEY=… node scripts/publish-agent-key.ts [--agent 10260] [--send]
//
// The next epoch is the agent's record epoch + 1 (agentKeyRecord: epochs continue across owners). If the key the seed
// derives for some epoch already resolves, nothing is sent. The key has no passkey behind it and so no rpId; the
// SDK takes such a key only from a client created with unsafeAllowAnyRpId, and that flag lifts only the rpId check:
// publishForAgent still refuses a key not derived for this agent, the owner's own key, and a caller that is not the
// agent's owner (the directory checks ownerOf).
import { letterlock, letterlockAbi, toHex } from "letterlock";
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentPublicKey } from "../src/agent-key.ts";
import { loadConfig } from "../src/config.ts";

const args = process.argv.slice(2);
const send = args.includes("--send");
const agentArg = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : undefined;
const config = loadConfig({ ...process.env, ...(agentArg ? { LETTERLOCK_AGENT_ID: agentArg } : {}) });
if (!config.seed) throw new Error("LETTERLOCK_AGENT_KEY_SEED is not set");
const ownerKey = process.env.OWNER_PRIVATE_KEY;
if (!ownerKey || !/^0x[0-9a-fA-F]{64}$/.test(ownerKey)) throw new Error("OWNER_PRIVATE_KEY must hold the agent owner's key (0x + 64 hex)");
const owner = privateKeyToAccount(ownerKey as `0x${string}`);

const ll = letterlock({ chain: config.chain, ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}), unsafeAllowAnyRpId: true });
const pub = createPublicClient({ transport: http(config.rpcUrl ?? (config.chain === "monad" ? "https://rpc.monad.xyz" : "https://testnet-rpc.monad.xyz")) });
const registry = await pub.readContract({ address: ll.directory, abi: letterlockAbi, functionName: "identityRegistry" });
const ownerOf = await pub.readContract({ address: registry, abi: parseAbi(["function ownerOf(uint256) view returns (address)"]), functionName: "ownerOf", args: [config.agentId] });
if (ownerOf.toLowerCase() !== owner.address.toLowerCase()) throw new Error(`agent ${config.agentId} is owned by ${ownerOf}, not ${owner.address}`);

const [recordKey, recordEpoch] = await pub.readContract({ address: ll.directory, abi: letterlockAbi, functionName: "agentKeyRecord", args: [config.agentId] });
if (recordEpoch >= config.keyFirstEpoch && `0x${toHex(agentPublicKey(config.seed, config.agentId, recordEpoch).publicKey)}` === recordKey.toLowerCase()) {
  console.log(JSON.stringify({ agent: `agent:${config.agentId}`, alreadyPublished: true, epoch: recordEpoch, publicKey: recordKey }, null, 2));
  process.exit(0);
}
const epoch = recordEpoch + 1;
if (epoch < config.keyFirstEpoch) throw new Error(`the next epoch is ${epoch}, below the first seed epoch ${config.keyFirstEpoch}`);
const next = agentPublicKey(config.seed, config.agentId, epoch);
const keys = { publicKey: next.publicKey, epoch, agentId: config.agentId };
const plan = {
  chain: ll.chainId,
  directory: ll.directory,
  agent: `agent:${config.agentId}`,
  owner: owner.address,
  current: { epoch: recordEpoch, publicKey: recordKey },
  next: { epoch, publicKey: `0x${toHex(next.publicKey)}`, kid: next.kid },
};

if (!send) {
  await pub.simulateContract({ account: owner, address: ll.directory, abi: letterlockAbi, functionName: "publishForAgent", args: [config.agentId, `0x${toHex(next.publicKey)}`, epoch] });
  console.log(JSON.stringify({ ...plan, simulated: "ok", sent: false, note: "run again with --send to publish" }, null, 2));
} else {
  const r = await ll.publishForAgent({ account: owner, agentId: config.agentId, keys });
  const resolved = await ll.resolve(`agent:${config.agentId}`);
  console.log(
    JSON.stringify(
      {
        ...plan,
        sent: true,
        transactionHash: r.transactionHash,
        blockNumber: r.blockNumber.toString(),
        gasUsed: r.gasUsed.toString(),
        resolvesNow: { epoch: resolved.epoch, kid: resolved.kid, matches: resolved.kid === next.kid && resolved.epoch === epoch },
      },
      null,
      2,
    ),
  );
}
