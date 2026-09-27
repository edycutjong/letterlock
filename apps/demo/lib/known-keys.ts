// Keys the app's own tests posted (lib/known-keys.json): the register marks their lines, so nobody seals a real note
// to a key whose passkey no longer exists.
import data from "./known-keys.json";
import { DEPLOYMENT } from "./chain.ts";

export type KnownKey = { chainId: number; address: string; txHash: string; note: string };

export const KNOWN_KEYS: KnownKey[] = (data.keys as KnownKey[]).filter((k) => k.chainId === DEPLOYMENT.chainId);
