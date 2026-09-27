"use client";

// The flows the pages run, each a sequence of SDK calls. Every passkey prompt is named in the step it belongs to, and
// the passkey account's signing session is ended (its key copy zeroed) as soon as the flow is done with it.
import {
  createEncryptionAddress,
  deriveFromPasskey,
  fingerprint,
  meraAccount,
  type DropResult,
  type Envelope,
  type MeraAccount,
  type PublishResult,
} from "letterlock";
import type { Address } from "viem";
import { DEPLOYMENT } from "./chain.ts";
import { passkeyClient } from "./client.ts";
import { DripRefused, PostageDue } from "./failure.ts";
import { dropGas, postageFor, publishPostage, requestDrip, waitForFunds, type DripReceipt } from "./gas.ts";
import { writeStored, type StoredPasskey } from "./session.ts";

export type StepName = "key" | "account" | "postage" | "publish";

export type StepReport = {
  readonly step: StepName;
  readonly status: "active" | "done" | "skipped";
  /** a fact to print beside the step: a fingerprint, an address, an amount */
  readonly detail?: string;
  readonly tx?: `0x${string}`;
};

type Report = (r: StepReport) => void;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The name your passkey manager lists the passkey under: the site's name and the minute it was made. */
export const passkeyName = (now = new Date()): string =>
  `Letterlock · ${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

const FIRST_KEY_ONLY = "it pays for an address’s first key only";

/**
 * Makes sure the account can pay for one publish. An account with no key yet asks the gas drip (the drip refuses an
 * account that already has a key, so a rotation is paid from the account's own MON); then waits until the MON can be
 * spent. Throws PostageDue, which the page shows as the "postage due" slip.
 */
const ensurePostage = async (account: MeraAccount, hasKey: boolean, report: Report): Promise<DripReceipt | undefined> => {
  report({ step: "postage", status: "active" });
  const { balance, needed } = await publishPostage(account.address);
  if (balance >= needed) {
    report({ step: "postage", status: "skipped", detail: "the account already holds enough MON" });
    return undefined;
  }
  if (hasKey) throw new PostageDue(account.address, balance, needed, FIRST_KEY_ONLY);
  let drip: DripReceipt | undefined;
  try {
    drip = await requestDrip(account);
  } catch (e) {
    if (e instanceof DripRefused && e.code !== "CHAIN_UNAVAILABLE") throw new PostageDue(account.address, balance, needed, e.message);
    throw e;
  }
  report({ step: "postage", status: "active", detail: drip ? `${drip.amount} MON from the gas drip` : undefined, tx: drip?.transactionHash });
  await waitForFunds(account.address, needed);
  report({ step: "postage", status: "done", detail: drip ? `${drip.amount} MON from the gas drip` : "funded", tx: drip?.transactionHash });
  return drip;
};

export type Created = { readonly stored: StoredPasskey; readonly published: PublishResult; readonly drip?: DripReceipt };

/**
 * Create my encryption address: a new passkey and its epoch-1 key (prompt 1, or 2 when the authenticator returns no PRF
 * output at creation), the passkey's account (one more prompt), postage, then publish(). The credential is stored as
 * soon as it exists, so a flow cut short can be finished later (postMyKey) with the same passkey.
 */
export const createAddress = async (report: Report): Promise<Created> => {
  const { rpId, client } = passkeyClient();
  report({ step: "key", status: "active" });
  const { keys, credential } = await createEncryptionAddress({
    rp: { id: rpId, name: "Letterlock" },
    user: { name: passkeyName(), displayName: "Letterlock encryption address" },
  });
  keys.secretKey.fill(0); // publishing needs only the public half
  let stored: StoredPasskey = { v: 1, chainId: DEPLOYMENT.chainId, rpId, credentialId: credential.credentialId, ...(credential.transports ? { transports: credential.transports } : {}) };
  writeStored(stored);
  report({ step: "key", status: "done", detail: fingerprint(keys.publicKey) });

  report({ step: "account", status: "active" });
  const account = await meraAccount({ rpId, credential });
  try {
    stored = { ...stored, address: account.address };
    writeStored(stored);
    report({ step: "account", status: "done", detail: account.address });
    const drip = await ensurePostage(account, false, report);
    report({ step: "publish", status: "active" });
    const published = await client.publish({ account, keys });
    report({ step: "publish", status: "done", detail: `epoch ${published.epoch}`, tx: published.transactionHash });
    return { stored, published, ...(drip ? { drip } : {}) };
  } finally {
    account.end();
  }
};

/** Finish a first publish that was cut short: the stored passkey derives its epoch-1 key and its account again. */
export const postMyKey = async (stored: StoredPasskey, report: Report): Promise<Created> => {
  const { rpId, client } = passkeyClient();
  const credential = { credentialId: stored.credentialId, ...(stored.transports ? { transports: stored.transports as never } : {}) };
  report({ step: "key", status: "active" });
  const keys = await deriveFromPasskey({ rpId, epoch: 1, credential });
  keys.secretKey.fill(0);
  report({ step: "key", status: "done", detail: fingerprint(keys.publicKey) });
  report({ step: "account", status: "active" });
  const account = await meraAccount({ rpId, credential });
  try {
    const next: StoredPasskey = { ...stored, address: account.address };
    writeStored(next);
    report({ step: "account", status: "done", detail: account.address });
    const drip = await ensurePostage(account, false, report);
    report({ step: "publish", status: "active" });
    const published = await client.publish({ account, keys });
    report({ step: "publish", status: "done", detail: `epoch ${published.epoch}`, tx: published.transactionHash });
    return { stored: next, published, ...(drip ? { drip } : {}) };
  } finally {
    account.end();
  }
};

/**
 * Rotate: the account (one prompt), then rotate() derives epoch + 1 from the same passkey (one more) and publishes it.
 * The postage is checked first, from the stored address, so an account that cannot pay is told so before any prompt.
 */
export const rotateKey = async (stored: StoredPasskey & { address: Address }, report: Report): Promise<PublishResult> => {
  const { rpId, client } = passkeyClient();
  const { balance, needed } = await publishPostage(stored.address);
  if (balance < needed) throw new PostageDue(stored.address, balance, needed, FIRST_KEY_ONLY);
  report({ step: "account", status: "active" });
  const account = await meraAccount({ rpId, credential: { credentialId: stored.credentialId } });
  try {
    report({ step: "account", status: "done", detail: account.address });
    await ensurePostage(account, true, report);
    report({ step: "publish", status: "active" });
    const published = await client.rotate({ account });
    report({ step: "publish", status: "done", detail: `epoch ${published.epoch}`, tx: published.transactionHash });
    return published;
  } finally {
    account.end();
  }
};

/**
 * Post an envelope to its recipient's inbox from the stored passkey account: the postage is checked from the stored
 * address before the prompt (a drop is never paid by the drip), then the account signs drop().
 */
export const postEnvelope = async (stored: StoredPasskey & { address: Address }, envelope: Envelope): Promise<DropResult> => {
  const { rpId, client } = passkeyClient();
  const gas = await dropGas(stored.address, envelope);
  const { balance, needed } = await postageFor(stored.address, gas);
  if (balance < needed) throw new PostageDue(stored.address, balance, needed, "it pays for an address’s first key only, never for posting a letter");
  const account = await meraAccount({ rpId, credential: { credentialId: stored.credentialId } });
  try {
    return await client.drop({ account, envelope });
  } finally {
    account.end();
  }
};

/** Find my address with my passkey: one prompt, no transaction. The device remembers the passkey afterwards. */
export const findMyAddress = async (): Promise<StoredPasskey & { address: Address }> => {
  const { rpId } = passkeyClient();
  const account = await meraAccount({ rpId });
  account.end(); // only its address was needed
  const stored = { v: 1 as const, chainId: DEPLOYMENT.chainId, rpId, credentialId: account.credentialId, address: account.address };
  writeStored(stored);
  return stored;
};

/** Open with passkey: one prompt, pinned to the stored passkey when the envelope is addressed to it. */
export const openEnvelope = async (envelope: Envelope, stored: StoredPasskey | undefined | null): Promise<Uint8Array> => {
  const { client } = passkeyClient();
  const mine = stored?.address !== undefined && envelope.recipient.toLowerCase() === stored.address.toLowerCase();
  return client.open(envelope, mine && stored ? { credential: { credentialId: stored.credentialId } } : {});
};
