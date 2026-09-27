"use client";

// What this device remembers about your passkey: its credential id and transports (public metadata that pins later
// prompts to it) and, once known, the passkey account's address. Nothing secret: no PRF output, no key, no seed. It
// lives in localStorage under one key per chain and rpId, and every read and write is guarded, because storage can be
// missing, full, or blocked (private windows, cleared site data). Without it the app still works: your passkey finds
// your address again ("Find my inbox with my passkey").
import { useCallback, useSyncExternalStore } from "react";
import { DEPLOYMENT } from "./chain.ts";

export type StoredPasskey = {
  readonly v: 1;
  readonly chainId: number;
  readonly rpId: string;
  /** base64url, as mera returns it */
  readonly credentialId: string;
  readonly transports?: readonly string[];
  /** the passkey's account (mera), once a prompt has derived it */
  readonly address?: `0x${string}`;
};

const keyFor = (rpId: string) => `letterlock:v1:${DEPLOYMENT.chainId}:${rpId}`;
const CHANGED = "letterlock:stored-changed";

const valid = (x: unknown, rpId: string): x is StoredPasskey => {
  if (typeof x !== "object" || x === null) return false;
  const s = x as Record<string, unknown>;
  return (
    s.v === 1 &&
    s.chainId === DEPLOYMENT.chainId &&
    s.rpId === rpId &&
    typeof s.credentialId === "string" &&
    /^[A-Za-z0-9_-]{16,1400}$/.test(s.credentialId) &&
    (s.transports === undefined || (Array.isArray(s.transports) && s.transports.every((t) => typeof t === "string"))) &&
    (s.address === undefined || (typeof s.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(s.address)))
  );
};

export const readStored = (rpId: string): StoredPasskey | undefined => {
  try {
    const raw = window.localStorage.getItem(keyFor(rpId));
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed, rpId) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const writeStored = (s: StoredPasskey): boolean => {
  try {
    window.localStorage.setItem(keyFor(s.rpId), JSON.stringify(s));
    window.dispatchEvent(new Event(CHANGED));
    return true;
  } catch {
    return false;
  }
};

export const forgetStored = (rpId: string): void => {
  try {
    window.localStorage.removeItem(keyFor(rpId));
  } catch {
    // nothing to forget
  }
  window.dispatchEvent(new Event(CHANGED));
};

const subscribe = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
};

/** snapshots must be stable between renders: cache the parsed value by its raw text */
let cache: { raw: string | null; value: StoredPasskey | undefined } | undefined;
const snapshot = (rpId: string): StoredPasskey | undefined => {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(keyFor(rpId));
  } catch {
    raw = null;
  }
  if (cache && cache.raw === raw) return cache.value;
  cache = { raw, value: readStored(rpId) };
  return cache.value;
};

/**
 * The stored passkey for `rpId`, kept in step with other tabs. `null` while the page is still being hydrated (the
 * server cannot see this device's storage), `undefined` when nothing is stored.
 */
export function useStoredPasskey(rpId: string | undefined): StoredPasskey | undefined | null {
  const get = useCallback(() => (rpId ? snapshot(rpId) : undefined), [rpId]);
  return useSyncExternalStore(subscribe, get, () => null);
}
