// Shared helpers for the chain tests: the anvil chain from global-setup.ts, fresh funded accounts (every test signs
// with its own random key, so test files can run in parallel on one chain), and the test-double registries.
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { inject } from "vitest";
import { letterlock, type LetterlockConfig } from "../../src/index.ts";

export const ctx = inject("anvil");
/** For describe.skipIf: why the chain tests cannot run here, or false. */
export const noChain: string | false = ctx.ok ? false : ctx.reason;

/** The anvil context, narrowed: throws where the chain tests cannot run (they are skipped there anyway). */
export const anvil = () => {
  if (!ctx.ok) throw new Error(ctx.reason);
  return ctx;
};
const must = anvil;

export const anvilChain = () => {
  const c = must();
  return { id: 143, name: "anvil (chain id 143)", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [c.rpcUrl] } } } as const;
};
export const publicClient = () => createPublicClient({ chain: anvilChain(), transport: http(must().rpcUrl) });
export const testClient = () => createTestClient({ mode: "anvil", chain: anvilChain(), transport: http(must().rpcUrl) });

/** A client for the anvil directory, as an app would configure one for mainnet (chain "monad", chain id 143). */
export const client = (over: Partial<LetterlockConfig> = {}) => {
  const c = must();
  return letterlock({ chain: "monad", rpcUrl: c.rpcUrl, directory: c.directory, deployBlock: BigInt(c.deployBlock), pollingInterval: 50, ...over });
};

export const fund = async (address: Address, mon = "10") => testClient().setBalance({ address, value: parseEther(mon) });

/** A new random key with MON on anvil. */
export const fundedAccount = async (mon = "10"): Promise<PrivateKeyAccount> => {
  const account = privateKeyToAccount(generatePrivateKey());
  await fund(account.address, mon);
  return account;
};

export const registryAbi = parseAbi([
  "function mint(address to, uint256 agentId)",
  "function transfer(uint256 agentId, address to)",
  "function burn(uint256 agentId)",
  "function ownerOf(uint256 agentId) view returns (address)",
]);
export const faultyAbi = parseAbi([
  "function mint(address to, uint256 agentId)",
  "function setFault(uint8 f)",
]);
/** FaultyIdentityRegistry.Fault */
export const Fault = { None: 0, EmptyRevert: 1, OutOfGas: 2, ErrorString: 3, OtherCustomError: 4, Panic: 5, SelectorPrefix: 6, MalformedAnswer: 7 } as const;

/** Sends one transaction from a fresh funded key (the test-double registries let anyone mint and move agents). */
export const sendAs = async (address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<Hex> => {
  const account = await fundedAccount("1");
  const wallet = createWalletClient({ account, chain: anvilChain(), transport: http(must().rpcUrl) });
  const hash = await wallet.writeContract({ address, abi, functionName, args } as never);
  const receipt = await publicClient().waitForTransactionReceipt({ hash, pollingInterval: 50 });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return hash;
};

/** A random agent id, so parallel tests never share one. */
export const newAgentId = () => BigInt(Math.floor(Math.random() * 2 ** 48)) + 1_000_000n;
