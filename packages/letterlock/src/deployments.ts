/**
 * Where Letterlock runs. The directory addresses and blocks are copied from deployments/143.json and
 * deployments/10143.json at the repository root (test/deployments.test.ts fails if they drift), so the package needs
 * no file or network access to know them.
 */
export type LetterlockChain = "monad" | "monad-testnet";

export type Deployment = {
  readonly chainId: number;
  readonly network: string;
  /** The Letterlock directory contract. */
  readonly directory: `0x${string}`;
  /** The block of the directory's deploy transaction: inbox() scans from here by default. */
  readonly deployBlock: bigint;
  /** The ERC-8004 IdentityRegistry the directory reads, or address(0): agent keys disabled (testnet). */
  readonly identityRegistry: `0x${string}`;
  /** The default JSON-RPC endpoint. */
  readonly rpcUrl: string;
  /** Block explorer, for links. */
  readonly explorer: string;
};

export const DEPLOYMENTS = {
  monad: {
    chainId: 143,
    network: "Monad mainnet",
    directory: "0xA25BBACAb3fD2e71da1Aa002e54965B488d64b7e",
    deployBlock: 108289180n,
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    rpcUrl: "https://rpc.monad.xyz",
    explorer: "https://monadvision.com",
  },
  "monad-testnet": {
    chainId: 10143,
    network: "Monad testnet",
    directory: "0x3Da5f339E20AB7325ffBb9df57Fb5656ca1f8b3a",
    deployBlock: 65956688n,
    identityRegistry: "0x0000000000000000000000000000000000000000",
    rpcUrl: "https://testnet-rpc.monad.xyz",
    explorer: "https://testnet.monadvision.com",
  },
} as const satisfies Record<LetterlockChain, Deployment>;

/**
 * The one WebAuthn relying party Letterlock keys are derived under (docs/SPEC.md §6). A PRF output is bound to the
 * rpId, so a key derived on any other origin (localhost, a preview deploy) can never be re-derived here, and every
 * note sealed to it would be unopenable in production. The client refuses publish() and rotate() under any other
 * rpId unless it is created with `unsafeAllowAnyRpId: true` (tests only).
 */
export const LETTERLOCK_RP_ID = "letterlock-app.vercel.app";

/** The directory's "no agent" marker (type(uint256).max): `toAgent` of a drop to an address. */
export const NO_AGENT = (1n << 256n) - 1n;

/** The largest envelope drop() accepts, in bytes (the directory's MAX_ENVELOPE_BYTES). */
export const MAX_ENVELOPE_BYTES = 16 * 1024;
