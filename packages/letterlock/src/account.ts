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

/**
 * One passkey prompt → the passkey's EVM account, as a viem account, so the SAME passkey that derives the encryption
 * key also signs the publish transaction (msg.sender is the passkey account: docs/SPEC.md §7).
 *
 * The account is mera's passkey account (mera docs, "Create passkey accounts"): the PRF output for mera's own salt
 * SHA-256("mera.prf.salt.v1") is BIP-39 entropy; its seed's BIP-32 key at m/44'/60'/0'/0/0 is the secp256k1 key.
 * The encryption key uses Letterlock's salts (§2), so the two keys are unrelated. Any wallet that follows the same
 * recipe derives the same address from the same passkey.
 *
 * Best effort on secrets: the PRF output, the seed and the HD keys are zeroed once the session holds its own copy.
 * The mnemonic is a JS string and cannot be zeroed.
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
  const seed = mnemonicToSeedSync(entropyToMnemonic(prf.prfOutput, wordlist));
  prf.prfOutput.fill(0);
  const master = HDKey.fromMasterSeed(seed);
  seed.fill(0);
  const node = master.derive(MERA_ACCOUNT_PATH);
  master.wipePrivateData();
  if (!node.privateKey) throw new LetterlockError("PASSKEY_FAILED", "the passkey's account key could not be derived");
  const session = createSecp256k1SigningSession({ privateKey: node.privateKey });
  node.wipePrivateData();
  return Object.assign(toViemAccount(session), { credentialId: prf.credentialId, end: () => session.end() });
};
