// meraAccount(): the passkey's EVM account through mera's signing session and viem adapter, driven by the software
// authenticator (test/soft-authenticator.ts) through the REAL mera ceremonies.
import { getPasskeyPrfOutput } from "@category-labs/mera";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { verifyMessage } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { LETTERLOCK_RP_ID, MERA_ACCOUNT_PATH, createEncryptionAddress, isLetterlockError, meraAccount, toHex } from "../src/index.ts";
import { client, fund, noChain } from "./anvil/context.ts";
import { fixedPrfAuthenticator, softAuthenticator, zeroedDuring } from "./soft-authenticator.ts";

const rp = { id: LETTERLOCK_RP_ID, name: "Letterlock" };
const user = { name: "maya", displayName: "Maya" };

describe("meraAccount", () => {
  it("is mera's passkey account: BIP-39 over the PRF output for mera's own salt, BIP-32 m/44'/60'/0'/0/0", async () => {
    const dev = softAuthenticator();
    const { credential } = await createEncryptionAddress({ rp, user, webAuthnClient: dev });
    const account = await meraAccount({ rpId: rp.id, credential, webAuthnClient: dev });
    // derived again, independently: mera's default-salt PRF, then viem's own BIP-39/BIP-32 implementation
    const { prfOutput } = await getPasskeyPrfOutput({ rpId: rp.id, credential, webAuthnClient: dev });
    const expected = mnemonicToAccount(entropyToMnemonic(prfOutput, wordlist), { path: MERA_ACCOUNT_PATH });
    expect(account.address).toBe(expected.address);
    expect(account.source).toBe("mera");
    expect(account.credentialId).toBe(credential.credentialId);
  });

  it("pins the account: PRF output 07…07 for mera's salt → the key at m/44'/60'/0'/0/0 → 0x2945…779f (checked with Foundry's cast)", async () => {
    // cast wallet address --mnemonic "<entropyToMnemonic(07…07)>" --mnemonic-derivation-path "m/44'/60'/0'/0/0"
    const dev = fixedPrfAuthenticator(new Uint8Array(32).fill(7));
    const account = await meraAccount({ rpId: rp.id, webAuthnClient: dev });
    expect(dev.salts.map(toHex)).toEqual(["896d46ac4ac191885c46137439db7bb52fb05cff3ecd34af7cdae0a1e0c00db9"]); // SHA-256("mera.prf.salt.v1")
    expect(MERA_ACCOUNT_PATH).toBe("m/44'/60'/0'/0/0");
    expect(account.address).toBe("0x29458C602E3DB4fC3b54EC2bbEE26Dbe64C7779f");
  });

  it("zeroes its copies of the PRF output and the BIP-39 seed once the signing session holds the key", async () => {
    const prfOutput = new Uint8Array(32).fill(7);
    const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
    const zeroed = await zeroedDuring(() => meraAccount({ rpId: rp.id, webAuthnClient: fixedPrfAuthenticator(prfOutput) }));
    expect(zeroed).toContain(toHex(prfOutput));
    expect(zeroed).toContain(toHex(seed));
  });

  it("zeroes every HD key on the path, the master key included, and the account key it hands the signing session", async () => {
    const prfOutput = new Uint8Array(32).fill(7);
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist)));
    const path = ["m", "m/44'", "m/44'/60'", "m/44'/60'/0'", "m/44'/60'/0'/0", MERA_ACCOUNT_PATH];
    const keys = path.map((p) => toHex(master.derive(p).privateKey!));
    expect(privateKeyToAccount(`0x${keys.at(-1)!}`).address).toBe("0x29458C602E3DB4fC3b54EC2bbEE26Dbe64C7779f"); // the pinned account
    const zeroed = await zeroedDuring(() => meraAccount({ rpId: rp.id, webAuthnClient: fixedPrfAuthenticator(prfOutput) }));
    for (const [i, key] of keys.entries()) expect(zeroed, path[i]).toContain(key);
    // the account key twice: the HD key's own copy, and the copy handed to the session (which keeps a copy of its own)
    expect(zeroed.filter((z) => z === keys.at(-1)).length).toBeGreaterThanOrEqual(2);
  });

  it("the same passkey on a synced device gives the same account; another passkey another account", async () => {
    const mac = softAuthenticator();
    const { credential } = await createEncryptionAddress({ rp, user, webAuthnClient: mac });
    const a = await meraAccount({ rpId: rp.id, credential, webAuthnClient: mac });
    const b = await meraAccount({ rpId: rp.id, credential, webAuthnClient: mac.syncedTo() });
    const other = softAuthenticator();
    await createEncryptionAddress({ rp, user, webAuthnClient: other });
    const c = await meraAccount({ rpId: rp.id, webAuthnClient: other });
    expect(b.address).toBe(a.address);
    expect(c.address).not.toBe(a.address);
  });

  it("is unrelated to the encryption key: separate salts, one prompt each", async () => {
    const dev = softAuthenticator();
    const { keys, credential } = await createEncryptionAddress({ rp, user, webAuthnClient: dev });
    expect(dev.calls).toEqual({ create: 1, get: 0 });
    const account = await meraAccount({ rpId: rp.id, credential, webAuthnClient: dev });
    expect(dev.calls).toEqual({ create: 1, get: 1 });
    expect(account.publicKey.includes(toHex(keys.publicKey))).toBe(false);
  });

  it("signs with no further prompt until end(); after end() every signature rejects", async () => {
    const dev = softAuthenticator();
    const { credential } = await createEncryptionAddress({ rp, user, webAuthnClient: dev });
    const account = await meraAccount({ rpId: rp.id, credential, webAuthnClient: dev });
    const signature = await account.signMessage({ message: "letterlock" });
    expect(await verifyMessage({ address: account.address, message: "letterlock", signature })).toBe(true);
    expect(dev.calls.get).toBe(1);
    account.end();
    await expect(account.signMessage({ message: "again" })).rejects.toThrow(/SESSION_ENDED|ended/i);
  });

  it("no passkey for the rpId → PASSKEY_FAILED; an authenticator without PRF → PRF_UNSUPPORTED", async () => {
    const dev = softAuthenticator();
    await createEncryptionAddress({ rp, user, webAuthnClient: dev });
    const e1 = await meraAccount({ rpId: "evil.test", webAuthnClient: dev }).then(() => null, (x: unknown) => x);
    expect(isLetterlockError(e1, "PASSKEY_FAILED")).toBe(true);
    const e2 = await meraAccount({ rpId: rp.id, webAuthnClient: softAuthenticator({ supportsPrf: false }, [{ id: new Uint8Array(16), rpId: rp.id, credRandom: new Uint8Array(32) }]) })
      .then(() => null, (x: unknown) => x);
    expect(isLetterlockError(e2, "PRF_UNSUPPORTED")).toBe(true);
  });
});

describe.skipIf(noChain)("meraAccount signs directory transactions", () => {
  it("a publish signed by an ended session → INPUT_INVALID, nothing sent", async () => {
    const dev = softAuthenticator();
    const { keys, credential } = await createEncryptionAddress({ rp, user, webAuthnClient: dev });
    const account = await meraAccount({ rpId: rp.id, credential, webAuthnClient: dev });
    await fund(account.address);
    account.end();
    const e = await client().publish({ account, keys }).then(() => null, (x: unknown) => x);
    expect(isLetterlockError(e, "INPUT_INVALID")).toBe(true);
    await expect(client().resolve(account.address)).rejects.toThrow(/NO_KEY_PUBLISHED/);
  });
});
