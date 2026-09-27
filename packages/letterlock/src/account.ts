import {
  createSecp256k1SigningSession,
  getPasskeyPrfOutput,
  type PasskeyCredentialMetadata,
  type WebAuthnClient,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { LocalAccount } from "viem";
import { LetterlockError } from "./errors.ts";
import { toPasskeyError } from "./passkey.ts";

/** BIP-44 path of the first Ethereum account: the one mera's passkey-account recipe derives. */
export const MERA_ACCOUNT_PATH = "m/44'/60'/0'/0/0";

export type MeraAccountOptions = {
  readonly rpId: string;
  /** Pins the prompt to one passkey (the credential createEncryptionAddress returned). */
  readonly credential?: PasskeyCredentialMetadata;
  readonly webAuthnClient?: WebAuthnClient;
  readonly timeout?: number;
};

/** A viem account whose key lives in a mera signing session: signing shows no prompt until end() is called. */
export type MeraAccount = LocalAccount<"mera"> & {
  /**
   * The passkey that answered, as base64url: pass it back as `credential` to pin later prompts. The chain client holds
   * the account to it: rotate() pins its prompt to this passkey, and publish(), rotate() and publishForAgent() refuse a
   * key that does not name it (docs/SPEC.md §7).
   */
  readonly credentialId: string;
  /** Zeroes the session's key copy; every later signature rejects (mera SESSION_ENDED). */
  end(): void;
};

const HARDENED = 0x8000_0000;
/** MERA_ACCOUNT_PATH as BIP-32 child indices: 44', 60', 0', 0, 0. */
const PATH_INDICES = MERA_ACCOUNT_PATH.split("/").slice(1).map((s) => (s.endsWith("'") ? Number(s.slice(0, -1)) + HARDENED : Number(s)));

/**
 * The secp256k1 key at MERA_ACCOUNT_PATH of `seed`, derived one level at a time so that each HD key on the path, the
 * master key first, is zeroed as soon as its child exists (HDKey.derive() leaves the keys between the master and the
 * leaf as they are). Returns a copy, which the caller zeroes.
 */
const accountKeyOf = (seed: Uint8Array): Uint8Array => {
  let node = HDKey.fromMasterSeed(seed);
  try {
    for (const index of PATH_INDICES) {
      const child = node.deriveChild(index);
      node.wipePrivateData();
      node = child;
    }
    const key = node.privateKey;
    if (!key) throw new LetterlockError("PASSKEY_FAILED", "the passkey's account key could not be derived");
    return key;
  } finally { node.wipePrivateData(); }
};

/**
 * One passkey prompt → the passkey's EVM account, as a viem account, so the SAME passkey that derives the encryption
 * key also signs the publish transaction (msg.sender is the passkey account: docs/SPEC.md §7).
 *
 * The account is mera's passkey account (mera docs, "Create passkey accounts"): the PRF output for mera's own salt
 * SHA-256("mera.prf.salt.v1") is BIP-39 entropy; its seed's BIP-32 key at m/44'/60'/0'/0/0 is the secp256k1 key.
 * The encryption key uses Letterlock's salts (§2), so the two keys are unrelated. Any wallet that follows the same
 * recipe derives the same address from the same passkey.
 *
 * Best effort on secrets: the PRF output, the seed, every HD key on the path and the copy of the key handed to the
 * session are zeroed before this returns; the session keeps its own copy until end(). The mnemonic is a JS string and
 * cannot be zeroed, and copies inside the libraries (HMAC inputs and outputs) are out of reach.
 */
export const meraAccount = async (o: MeraAccountOptions): Promise<MeraAccount> => {
  let prf: { prfOutput: Uint8Array; credentialId: string };
  try {
    prf = await getPasskeyPrfOutput({
      rpId: o.rpId,
      ...(o.credential ? { credential: o.credential } : {}),
      ...(o.webAuthnClient ? { webAuthnClient: o.webAuthnClient } : {}),
      ...(o.timeout !== undefined ? { timeout: o.timeout } : {}),
    });
  } catch (e) { return toPasskeyError(e); }
  let seed: Uint8Array;
  try { seed = mnemonicToSeedSync(entropyToMnemonic(prf.prfOutput, wordlist)); }
  finally { prf.prfOutput.fill(0); }
  let key: Uint8Array;
  try { key = accountKeyOf(seed); }
  finally { seed.fill(0); }
  let session: ReturnType<typeof createSecp256k1SigningSession>;
  try { session = createSecp256k1SigningSession({ privateKey: key }); } // the session keeps a copy of its own
  finally { key.fill(0); }
  return Object.assign(toViemAccount(session), { credentialId: prf.credentialId, end: () => session.end() });
};
