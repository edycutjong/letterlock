// Starts a local anvil chain with chain id 143 and deploys the directory with `forge create`, compiled from
// contracts/src/Letterlock.sol into a scratch folder (contracts/out is left alone). Deterministic: anvil's default
// accounts and a fixed deploy order give the same addresses on every run, and the compiled creation code must hash
// to the value deployments/143.json records for the mainnet deploy (checked in test/deployments.test.ts), so the
// tests run against the exact contract that is live on Monad.
//
// Directories deployed:
//   directory          registry = 0x8004A169…a432, the mainnet ERC-8004 address, where a test-double registry is
//                      placed with anvil_setCode (open mint/transfer/burn): the agent path is enabled
//   directoryFaulty    registry = FaultyIdentityRegistry, whose ownerOf fails on demand (RegistryCallFailed)
//   directoryNoAgents  registry = address(0): the agent path is disabled, as on Monad testnet
//
// Without forge and anvil on PATH the chain tests skip with the reason; LETTERLOCK_REQUIRE_ANVIL=1 fails instead.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createPublicClient, createTestClient, http, keccak256, type Address, type Hex } from "viem";
import type { TestProject } from "vitest/node";

export type AnvilContext =
  | {
      readonly ok: true;
      readonly rpcUrl: string;
      readonly chainId: 143;
      /** anvil's first default account, which deployed everything (unlocked: anvil signs for it). */
      readonly deployer: Address;
      readonly directory: Address;
      readonly directoryFaulty: Address;
      readonly directoryNoAgents: Address;
      readonly registry: Address;
      readonly faultyRegistry: Address;
      /** Block of the `directory` deploy. */
      readonly deployBlock: string;
      /** keccak256 of the compiled Letterlock creation code (no constructor argument). */
      readonly creationCodeHash: Hex;
    }
  | { readonly ok: false; readonly reason: string };

declare module "vitest" {
  export interface ProvidedContext {
    anvil: AnvilContext;
  }
}

const run = promisify(execFile);
const CONTRACTS = fileURLToPath(new URL("../../../../contracts/", import.meta.url));
/** The ERC-8004 IdentityRegistry address on Monad mainnet; on anvil a test double is placed there. */
export const REGISTRY: Address = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const DEPLOYER: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const startAnvil = (): Promise<{ proc: ChildProcess; url: string }> =>
  new Promise((resolve, reject) => {
    const proc = spawn("anvil", ["--port", "0", "--chain-id", "143"], { stdio: ["ignore", "pipe", "pipe"] });
    let seen = "";
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`anvil did not start: ${seen.slice(-400)}`)); }, 20_000);
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.stdout!.on("data", (d: Buffer) => {
      seen += d.toString();
      const m = /Listening on ([0-9.]+:\d+)/.exec(seen);
      if (m) { clearTimeout(timer); resolve({ proc, url: `http://${m[1]}` }); }
    });
  });

export default async function setup(project: TestProject) {
  const required = process.env.LETTERLOCK_REQUIRE_ANVIL === "1";
  try {
    await run("forge", ["--version"]);
    await run("anvil", ["--version"]);
  } catch (e) {
    if (required) throw e;
    project.provide("anvil", { ok: false, reason: `forge and anvil (Foundry) are needed for the chain tests: ${(e as Error).message}` });
    return;
  }

  const scratch = await mkdtemp(join(tmpdir(), "letterlock-sdk-test-"));
  const build = ["--root", CONTRACTS, "--out", join(scratch, "out"), "--cache-path", join(scratch, "cache")];
  await run("forge", ["build", ...build, "src/Letterlock.sol", "test/mocks/MockIdentityRegistry.sol", "test/mocks/FaultyIdentityRegistry.sol"],
    { cwd: CONTRACTS, maxBuffer: 1 << 24 });
  const artifact = JSON.parse(await readFile(join(scratch, "out", "Letterlock.sol", "Letterlock.json"), "utf8")) as { bytecode: { object: Hex } };

  const { proc, url } = await startAnvil();
  const create = async (contract: string, ...constructorArgs: string[]): Promise<{ address: Address; tx: Hex }> => {
    const { stdout } = await run("forge", [
      "create", ...build, contract, "--rpc-url", url, "--unlocked", "--from", DEPLOYER, "--broadcast", "--json",
      ...(constructorArgs.length ? ["--constructor-args", ...constructorArgs] : []),
    ], { cwd: CONTRACTS, maxBuffer: 1 << 24 });
    const out = JSON.parse(stdout.slice(stdout.indexOf("{"))) as { deployedTo: Address; transactionHash: Hex };
    return { address: out.deployedTo, tx: out.transactionHash };
  };

  try {
    const chain = { id: 143, name: "anvil", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [url] } } } as const;
    const test = createTestClient({ mode: "anvil", chain, transport: http(url) });
    const pub = createPublicClient({ chain, transport: http(url) });

    const mock = await create("test/mocks/MockIdentityRegistry.sol:MockIdentityRegistry");
    await test.setCode({ address: REGISTRY, bytecode: (await pub.getCode({ address: mock.address }))! });
    const main = await create("src/Letterlock.sol:Letterlock", REGISTRY);
    const faulty = await create("test/mocks/FaultyIdentityRegistry.sol:FaultyIdentityRegistry");
    const directoryFaulty = await create("src/Letterlock.sol:Letterlock", faulty.address);
    const directoryNoAgents = await create("src/Letterlock.sol:Letterlock", "0x0000000000000000000000000000000000000000");
    const receipt = await pub.getTransactionReceipt({ hash: main.tx });

    project.provide("anvil", {
      ok: true,
      rpcUrl: url,
      chainId: 143,
      deployer: DEPLOYER,
      directory: main.address,
      directoryFaulty: directoryFaulty.address,
      directoryNoAgents: directoryNoAgents.address,
      registry: REGISTRY,
      faultyRegistry: faulty.address,
      deployBlock: receipt.blockNumber.toString(),
      creationCodeHash: keccak256(artifact.bytecode.object),
    });
  } catch (e) {
    proc.kill();
    await rm(scratch, { recursive: true, force: true });
    throw e;
  }

  return async () => {
    proc.kill();
    await rm(scratch, { recursive: true, force: true });
  };
}
