import type { PasskeyCredentialMetadata, WebAuthnClient } from "@category-labs/mera";
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  getAddress,
  hexToBytes,
  http,
  isAddress,
  zeroAddress,
  type Account,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { monad, monadTestnet } from "viem/chains";
import { letterlockAbi } from "./abi.ts";
import { answeredByCode, toLetterlockError } from "./chain-errors.ts";
import { DEPLOYMENTS, LETTERLOCK_RP_ID, MAX_ENVELOPE_BYTES, NO_AGENT, type LetterlockChain } from "./deployments.ts";
import { MAX_EPOCH, fingerprint } from "./derive.ts";
import { canonicalRecipient, encodeEnvelope, seal, toAgentId, type Envelope, type Recipient, type RecipientKey } from "./envelope.ts";
import { LetterlockError } from "./errors.ts";
import { readInbox, type InboxOptions, type InboxResult } from "./inbox.ts";
import { deriveFromPasskey, openWithPasskey } from "./passkey.ts";

export type LetterlockConfig = {
  readonly chain: LetterlockChain;
  /** JSON-RPC endpoint. Default: the chain's public RPC (https://rpc.monad.xyz, https://testnet-rpc.monad.xyz). */
  readonly rpcUrl?: string;
  /** Directory contract. Default: the Letterlock deployment on `chain`. */
  readonly directory?: Address;
  /** Where inbox() starts by default. Known for the built-in directories; pass it for another one. */
  readonly deployBlock?: bigint;
  /** The rpId keys are derived and opened under. Default: LETTERLOCK_RP_ID, the only one publish() accepts. */
  readonly rpId?: string;
  /**
   * Tests only: let publish(), rotate() and publishForAgent() run under an rpId other than LETTERLOCK_RP_ID, and take a
   * key that carries no rpId. A key that names another rpId than the client's is refused even then.
   */
  readonly unsafeAllowAnyRpId?: boolean;
  /** How often to poll for a receipt, in ms. Default: viem's, from Monad's block time (500 ms). */
  readonly pollingInterval?: number;
};

/** A key exactly as ONE keyOf / keyOfAgent read returned it: seal() takes it as is (docs/SPEC.md §3). */
export type ResolvedKey = RecipientKey & {
  readonly recipient: Recipient;
  /** Fingerprint of the key (docs/SPEC.md §2): the envelope's kid. */
  readonly kid: string;
  /** Block timestamp of the publish, in seconds. */
  readonly updatedAt: number;
  readonly chainId: number;
  readonly directory: Address;
};

/**
 * What publish needs: the public half, its epoch, and the rpId it was derived under, which must be the client's (the
 * keys createEncryptionAddress(), deriveFromPasskey() and deriveForAgent() return carry it). Only `unsafeAllowAnyRpId`
 * accepts no rpId. `agentId` marks an agent's key (deriveForAgent, deriveAgentKeyPair): publishForAgent() takes only a
 * key marked for that agent, and publish() never takes one.
 */
export type PublishableKey = { readonly publicKey: Uint8Array; readonly epoch: number; readonly rpId?: string; readonly agentId?: bigint };

export type WriteResult = {
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  /** Gas the receipt reports: on Monad, the gas limit, which is what is charged. */
  readonly gasUsed: bigint;
};

export type PublishResult = WriteResult & {
  readonly recipient: Recipient;
  readonly epoch: number;
  readonly publicKey: Hex;
  readonly kid: string;
};

export type DropResult = WriteResult & { readonly recipient: Recipient; readonly bytes: number };

/** A viem account: meraAccount() (the passkey signs), privateKeyToAccount(), or an address a node signs for. */
export type Signer = Account | Address;

export type LetterlockClient = {
  readonly chain: LetterlockChain;
  readonly chainId: number;
  readonly directory: Address;
  readonly rpId: string;
  /** One contract read: the key and epoch to seal to. Throws NO_KEY_PUBLISHED when none resolves. */
  resolve(to: string): Promise<ResolvedKey>;
  /** resolve + seal: bytes only the recipient's passkey opens. No passkey, no transaction. */
  sealTo(to: string, plaintext: Uint8Array): Promise<Envelope>;
  /** One passkey prompt: open an envelope with the key for its own epoch, derived under the client's rpId. */
  open(envelope: Envelope, o?: { credential?: PasskeyCredentialMetadata; webAuthnClient?: WebAuthnClient }): Promise<Uint8Array>;
  /** Publish the account's key; `keys.epoch` must be the directory's epoch for the account + 1 (1 for the first). */
  publish(o: { account: Signer; keys: PublishableKey }): Promise<PublishResult>;
  /** One passkey prompt: derive the next epoch's key (1 when none) and publish it. Old envelopes keep opening. */
  rotate(o: { account: Signer; credential?: PasskeyCredentialMetadata; webAuthnClient?: WebAuthnClient }): Promise<PublishResult>;
  /**
   * Publish an ERC-8004 agent's key; the account must own the agent. The key must come from deriveForAgent() for this
   * agent: never the owner's own key. Epochs continue across owners.
   */
  publishForAgent(o: { account: Signer; agentId: bigint | number | string; keys: PublishableKey }): Promise<PublishResult>;
  /** Emit an envelope on the directory (the demo transport). The recipient must have a key now. */
  drop(o: { account: Signer; envelope: Envelope }): Promise<DropResult>;
  /** The envelopes dropped for a recipient, read from Dropped logs in pages the RPC accepts. */
  inbox(to: string, o?: InboxOptions): Promise<InboxResult>;
};

const CHAINS = { monad, "monad-testnet": monadTestnet } as const;

/**
 * A Letterlock client for one chain and directory.
 *
 *   const ll = letterlock({ chain: "monad" });
 *   const envelope = await ll.sealTo("0x…", new TextEncoder().encode("only you can read this"));
 */
export const letterlock = (config: LetterlockConfig): LetterlockClient => {
  const deployment = DEPLOYMENTS[config.chain];
  if (!deployment) throw new LetterlockError("INPUT_INVALID", `chain must be "monad" or "monad-testnet", got ${JSON.stringify(config.chain)}`);
  // strict: a mixed-case address must carry a valid EIP-55 checksum, so a one-digit typo is refused here
  if (config.directory !== undefined && (typeof config.directory !== "string" || !isAddress(config.directory)))
    throw new LetterlockError("INPUT_INVALID", `directory must be a 0x address with a valid EIP-55 checksum (or all lower-case), got ${JSON.stringify(config.directory)}`);
  const { chainId, network } = deployment;
  const directory = getAddress(config.directory ?? deployment.directory);
  const builtIn = directory === getAddress(deployment.directory);
  const deployBlock = config.deployBlock ?? (builtIn ? deployment.deployBlock : undefined);
  const rpId = config.rpId ?? LETTERLOCK_RP_ID;
  const viemChain = CHAINS[config.chain];
  // One JSON-RPC request per HTTP request, never a batch: rpc-mainnet.monadinfra.com, one of the public RPCs in Monad's
  // docs, answers any batch (even a batch of one) with HTTP 403 "Restricted JSON RPC method".
  const transport = http(config.rpcUrl ?? deployment.rpcUrl);
  const publicClient = createPublicClient({
    chain: viemChain,
    transport,
    ...(config.pollingInterval !== undefined ? { pollingInterval: config.pollingInterval } : {}),
  });

  // One eth_chainId per client: a key read from another chain must never be sealed under this chain's id.
  // The RPC URL is left out of messages: it may carry an API key.
  let chainChecked: Promise<void> | undefined;
  const checkChain = (): Promise<void> =>
    (chainChecked ??= publicClient.getChainId().then(
      (id) => {
        if (id !== chainId) throw new LetterlockError("INPUT_INVALID", `the RPC serves chain ${id}, not ${network} (${chainId})`);
      },
      (e: unknown) => {
        chainChecked = undefined;
        throw toLetterlockError(e, "eth_chainId");
      },
    ));

  // One check per client that the address holds a Letterlock directory: code, and NO_AGENT() answering the marker.
  // Without it a codeless or mistyped directory takes publish and drop transactions (an address without code accepts
  // any call, and the gas is spent) and reads as an empty inbox. A failure is INPUT_INVALID (docs/SPEC.md §5); an RPC
  // that fails is CHAIN_UNAVAILABLE, and is asked again next time.
  const notADirectory = (why: string, cause?: unknown) =>
    new LetterlockError("INPUT_INVALID", `${directory} is not a Letterlock directory on ${network}: ${why}`, cause === undefined ? undefined : { cause });
  const verifyDirectory = async (): Promise<void> => {
    const [code, marker] = await Promise.allSettled([
      publicClient.getCode({ address: directory }),
      publicClient.readContract({ address: directory, abi: letterlockAbi, functionName: "NO_AGENT" }),
    ]);
    if (code.status === "rejected") throw toLetterlockError(code.reason, `eth_getCode(${directory})`);
    if (!code.value || code.value === "0x") throw notADirectory("the address has no code");
    if (marker.status === "rejected") {
      if (answeredByCode(marker.reason)) throw notADirectory("its code does not answer NO_AGENT()", marker.reason);
      throw toLetterlockError(marker.reason, `NO_AGENT() at ${directory}`);
    }
    if (marker.value !== NO_AGENT) throw notADirectory(`NO_AGENT() returned ${marker.value}, not 2^256 - 1`);
  };
  let directoryChecked: Promise<void> | undefined;
  const checkDirectory = (): Promise<void> =>
    (directoryChecked ??= verifyDirectory().catch((e: unknown) => { directoryChecked = undefined; throw e; }));

  /**
   * Runs `f` alongside the one-time checks, and reports a failed check before anything `f` threw: first the chain (on
   * another chain the directory address usually has no code, and "no directory" would hide that the RPC serves the
   * wrong chain), then the directory.
   */
  const checked = async <T>(f: () => Promise<T>): Promise<T> => {
    const [chain, dir, value] = await Promise.allSettled([checkChain(), checkDirectory(), f()]);
    if (chain.status === "rejected") throw chain.reason;
    if (dir.status === "rejected") throw dir.reason;
    if (value.status === "rejected") throw value.reason;
    return value.value;
  };
  const ready = (): Promise<void> => checked(async () => undefined);

  const read = async <T>(action: string, f: () => Promise<T>): Promise<T> => {
    try { return await checked(f); } catch (e) { throw toLetterlockError(e, action); }
  };

  let agentPath: Promise<boolean> | undefined;
  const agentPathEnabled = (): Promise<boolean> =>
    (agentPath ??= builtIn
      ? Promise.resolve(deployment.identityRegistry !== zeroAddress)
      : read("identityRegistry()", () => publicClient.readContract({ address: directory, abi: letterlockAbi, functionName: "identityRegistry" }))
        .then((registry) => registry !== zeroAddress, (e: unknown) => { agentPath = undefined; throw e; }));
  const requireAgentPath = async (action: string) => {
    if (!(await agentPathEnabled()))
      throw new LetterlockError("INPUT_INVALID", `${action}: the ${network} directory has no ERC-8004 registry, so it holds no agent keys (AgentPathDisabled)`);
  };

  const pinned = (action: string) => {
    if (rpId !== LETTERLOCK_RP_ID && config.unsafeAllowAnyRpId !== true)
      throw new LetterlockError("INPUT_INVALID",
        `${action}: rpId "${rpId}" is not the production rpId "${LETTERLOCK_RP_ID}". A key derived under another rpId can never be re-derived in production, so every note sealed to it would be unopenable`);
  };
  /** `forAgent`: the agent publishForAgent() writes, which the key must have been derived for; undefined for publish(). */
  const checkKey = (keys: PublishableKey, action: string, forAgent?: bigint) => {
    if (!keys || !(keys.publicKey instanceof Uint8Array) || keys.publicKey.length !== 32)
      throw new LetterlockError("INPUT_INVALID", `${action}: keys.publicKey must be the 32-byte X25519 public key`);
    if (!Number.isInteger(keys.epoch) || keys.epoch < 1 || keys.epoch > MAX_EPOCH)
      throw new LetterlockError("INPUT_INVALID", `${action}: keys.epoch must be an integer in 1..${MAX_EPOCH}, got ${keys.epoch}`);
    // An agent's key is derived with the agent id in its salt (docs/SPEC.md §2). The owner's own key would hand whoever
    // holds the agent's secret every note sealed to the owner, and link the two publicly.
    if (forAgent === undefined && keys.agentId !== undefined)
      throw new LetterlockError("INPUT_INVALID", `${action}: this key was derived for agent ${String(keys.agentId)}; publish it with publishForAgent`);
    if (forAgent !== undefined && keys.agentId !== forAgent)
      throw new LetterlockError("INPUT_INVALID", keys.agentId === undefined
        ? `${action}: this key was not derived for agent ${forAgent}. Derive it with deriveForAgent({ agentId: ${forAgent}, epoch }): a key from deriveFromPasskey() is the owner's own, and whoever holds the agent's secret could open every note sealed to the owner`
        : `${action}: this key was derived for agent ${String(keys.agentId)}, not agent ${forAgent}`);
    // The key must say where it was derived: a key rebuilt as { publicKey, epoch } has lost that, and could come from
    // any passkey. Only unsafeAllowAnyRpId (tests) takes a key without an rpId; none takes a key from another rpId.
    if (keys.rpId === undefined && config.unsafeAllowAnyRpId !== true)
      throw new LetterlockError("INPUT_INVALID",
        `${action}: the key carries no rpId. Pass the key createEncryptionAddress(), deriveFromPasskey() or deriveForAgent() returned (it records the rpId "${rpId}" it was derived under), not one rebuilt from its fields`);
    if (keys.rpId !== undefined && keys.rpId !== rpId)
      throw new LetterlockError("INPUT_INVALID", `${action}: the key was derived under rpId "${keys.rpId}", and this client publishes for "${rpId}"`);
  };
  const addressOf = (account: Signer, action: string): Address => {
    const a = typeof account === "string" ? account : account?.address;
    if (typeof a !== "string" || !isAddress(a, { strict: false }))
      throw new LetterlockError("INPUT_INVALID", `${action}: account must be a viem account (meraAccount(), privateKeyToAccount()) or an address`);
    return getAddress(a);
  };

  type Write = "publish" | "publishForAgent" | "drop";
  const send = async (account: Signer, functionName: Write, args: readonly unknown[], action: string): Promise<TransactionReceipt> => {
    const call = { account, address: directory, abi: letterlockAbi, functionName, args } as never;
    try {
      await ready(); // the chain and the directory, before anything is signed
      // simulate first: a call the directory would refuse costs no gas, and its error names the reason
      const { request } = await publicClient.simulateContract(call);
      const wallet = createWalletClient({ account, chain: viemChain, transport });
      const hash = await wallet.writeContract(request as never);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        await publicClient.simulateContract(call); // something changed since the simulation; name it if it still reverts
        throw new LetterlockError("CHAIN_UNAVAILABLE", `${action}: transaction ${hash} reverted when it was mined`);
      }
      return receipt;
    } catch (e) { throw toLetterlockError(e, action); }
  };
  const written = (r: TransactionReceipt): WriteResult => ({ transactionHash: r.transactionHash, blockNumber: r.blockNumber, gasUsed: r.gasUsed });

  const resolve = async (to: string): Promise<ResolvedKey> => {
    const recipient = canonicalRecipient(to);
    let key: readonly [Hex, number, bigint];
    if (recipient.startsWith("agent:")) {
      const agentId = toAgentId(recipient);
      await requireAgentPath(`resolve ${recipient}`);
      key = await read(`keyOfAgent(${agentId})`, () =>
        publicClient.readContract({ address: directory, abi: letterlockAbi, functionName: "keyOfAgent", args: [agentId] }));
    } else {
      key = await read(`keyOf(${recipient})`, () =>
        publicClient.readContract({ address: directory, abi: letterlockAbi, functionName: "keyOf", args: [recipient as Address] }));
    }
    const [pub, epoch, updatedAt] = key;
    if (epoch === 0 || BigInt(pub) === 0n)
      throw new LetterlockError("NO_KEY_PUBLISHED", `${recipient} has no key in the ${network} directory ${directory}`);
    const publicKey = hexToBytes(pub);
    return { recipient, publicKey, epoch, kid: fingerprint(publicKey), updatedAt: Number(updatedAt), chainId, directory };
  };

  const publishResult = (r: TransactionReceipt, recipient: Recipient, keys: PublishableKey): PublishResult => ({
    ...written(r), recipient, epoch: keys.epoch, publicKey: bytesToHex(keys.publicKey), kid: fingerprint(keys.publicKey),
  });

  const client: LetterlockClient = {
    chain: config.chain,
    chainId,
    directory,
    rpId,
    resolve,

    async sealTo(to, plaintext) {
      if (!(plaintext instanceof Uint8Array))
        throw new LetterlockError("INPUT_INVALID", "plaintext must be a Uint8Array (encode text with TextEncoder)");
      const key = await resolve(to);
      return seal({ chainId, directory, to: key, plaintext });
    },

    open: (envelope, o = {}) => openWithPasskey(envelope, { rpId, ...o }),

    async publish({ account, keys }) {
      pinned("publish");
      checkKey(keys, "publish");
      const address = addressOf(account, "publish");
      const r = await send(account, "publish", [bytesToHex(keys.publicKey), keys.epoch], `publish epoch ${keys.epoch} for ${address}`);
      return publishResult(r, address.toLowerCase() as Recipient, keys);
    },

    async rotate({ account, credential, webAuthnClient }) {
      pinned("rotate");
      const address = addressOf(account, "rotate");
      const [, current] = await read(`keyOf(${address})`, () =>
        publicClient.readContract({ address: directory, abi: letterlockAbi, functionName: "keyOf", args: [address] }));
      const keys = await deriveFromPasskey({
        rpId, epoch: current + 1, ...(credential ? { credential } : {}), ...(webAuthnClient ? { webAuthnClient } : {}),
      });
      keys.secretKey.fill(0); // publishing needs only the public half
      const r = await send(account, "publish", [bytesToHex(keys.publicKey), keys.epoch], `rotate ${address} to epoch ${keys.epoch}`);
      return publishResult(r, address.toLowerCase() as Recipient, keys);
    },

    async publishForAgent({ account, agentId, keys }) {
      pinned("publishForAgent");
      const id = toAgentId(agentId);
      checkKey(keys, `publishForAgent ${id}`, id);
      const owner = addressOf(account, "publishForAgent");
      await requireAgentPath(`publishForAgent ${id}`);
      // however the key was labelled, never the account's own published key
      const [ownKey] = await read(`keyOf(${owner})`, () =>
        publicClient.readContract({ address: directory, abi: letterlockAbi, functionName: "keyOf", args: [owner] }));
      if (BigInt(ownKey) !== 0n && ownKey.toLowerCase() === bytesToHex(keys.publicKey))
        throw new LetterlockError("INPUT_INVALID", `publishForAgent ${id}: this is ${owner}'s own key in the directory; an agent's key must be derived for the agent (deriveForAgent)`);
      const r = await send(account, "publishForAgent", [id, bytesToHex(keys.publicKey), keys.epoch], `publishForAgent ${id} epoch ${keys.epoch}`);
      return publishResult(r, `agent:${id}`, keys);
    },

    async drop({ account, envelope }) {
      addressOf(account, "drop");
      const bytes = encodeEnvelope(envelope);
      if (envelope.chainId !== chainId)
        throw new LetterlockError("INPUT_INVALID", `drop: the envelope is sealed for chain ${envelope.chainId}, and this client drops on ${network} (${chainId})`);
      if (envelope.directory.toLowerCase() !== directory.toLowerCase())
        throw new LetterlockError("INPUT_INVALID", `drop: the envelope is sealed for directory ${envelope.directory}, and this client drops to ${directory}`);
      if (bytes.length > MAX_ENVELOPE_BYTES)
        throw new LetterlockError("INPUT_INVALID", `drop: the envelope is ${bytes.length} bytes; the directory takes at most ${MAX_ENVELOPE_BYTES}`);
      const recipient = canonicalRecipient(envelope.recipient);
      const agent = recipient.startsWith("agent:");
      const to: Address = agent ? zeroAddress : (recipient as Address);
      const toAgent = agent ? toAgentId(recipient) : NO_AGENT;
      const r = await send(account, "drop", [to, toAgent, bytesToHex(bytes)], `drop ${bytes.length} bytes to ${recipient}`);
      return { ...written(r), recipient, bytes: bytes.length };
    },

    inbox: (to, o) => readInbox(publicClient, { chainId, directory, ...(deployBlock !== undefined ? { deployBlock } : {}), ready }, to, o),
  };
  return client;
};
