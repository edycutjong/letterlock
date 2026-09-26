// The directory the app points at, read from the deployment record at the repository root (written when the
// contract was deployed). These are real values, not examples: the footer, /register and /judge show them.
import testnet from "../../../deployments/10143.json";

export const DIRECTORY = {
  chainId: testnet.chainId,
  network: testnet.network,
  address: testnet.address as `0x${string}`,
  explorer: testnet.explorer.contract,
  verified: testnet.verified,
  verifier: testnet.verification.verifier,
  /** "exact_match": the first word of the recorded verification result */
  match: testnet.verification.match.split(" ")[0] ?? "",
  sourceCheck: testnet.verification.check,
  agentPathEnabled: testnet.identityRegistry !== "0x0000000000000000000000000000000000000000",
} as const;

/**
 * The one key on the testnet directory so far: the deploy smoke test's TEST KEY (the SDK's derivation over 32
 * random bytes standing in for a passkey PRF output; no passkey was used). `keyOf(deployer)` returned this key,
 * epoch 1 and updatedAt 1790433335 when read with `cast call` on 2026-09-27; that is the timestamp of block 65875618.
 */
export const TESTNET_TEST_KEY = {
  address: testnet.deployer as `0x${string}`,
  publicKey: testnet.smokeTest.publishedKey as `0x${string}`,
  epoch: testnet.smokeTest.epoch,
  fingerprint: testnet.smokeTest.kid,
  block: testnet.smokeTest.publishBlock,
  txHash: testnet.publishTx as `0x${string}`,
  txUrl: testnet.explorer.publishTx,
  updatedAt: 1790433335,
} as const;
