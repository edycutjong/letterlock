// What each SDK error means to the person in front of the page, and what they can do about it.
// Meanings follow docs/SPEC.md §5; a slip never shows a code without its recovery.
import type { LetterlockErrorCode } from "letterlock";
import { groupFingerprint } from "./keystrip.ts";

/** Every SDK failure a person can meet in the flow. INPUT_INVALID is a form error, shown beside the field instead. */
export type SlipCode = Exclude<LetterlockErrorCode, "INPUT_INVALID">;

export const SLIP_CODES = [
  "PRF_UNSUPPORTED",
  "PASSKEY_FAILED",
  "NO_KEY_PUBLISHED",
  "EPOCH_MISMATCH",
  "WRONG_KEY",
  "TAMPERED",
] as const satisfies readonly SlipCode[];

/** Values a slip can quote. Each is optional: without it the sentence stays true, only less specific. */
export type SlipValues = {
  /** the epoch the envelope names */
  envelopeEpoch?: number;
  /** the epoch of the key in hand */
  keyEpoch?: number;
  /** the envelope's kid: the key it was sealed to */
  sealedTo?: string;
  /** the fingerprint the chosen passkey derives */
  derived?: string;
};

export type SlipCopy = {
  /** the postal reason, set in the display italic */
  reason: string;
  /** one line for the tick-box list printed on every slip */
  box: string;
  /** what happened, in plain words */
  meaning: (v: SlipValues) => string;
  /** what to do next */
  recovery: (v: SlipValues) => string;
  /** the label of the button that carries out the recovery, when there is one */
  action?: string;
};

const epoch = (n: number | undefined, fallback: string) => (n === undefined ? fallback : `epoch ${n}`);
const key = (fp: string | undefined) => (fp ? groupFingerprint(fp) : undefined);

export const SLIP_COPY: Record<SlipCode, SlipCopy> = {
  PRF_UNSUPPORTED: {
    reason: "This passkey can’t make an encryption key.",
    box: "No key from this passkey",
    meaning: () =>
      "Your passkey provider returned no PRF output, and your encryption key is derived from that output. Some providers return none, for example Dashlane and some Chrome profiles.",
    recovery: () =>
      "Use a passkey saved in a provider that returns PRF output, such as iCloud Keychain in Safari 18 or later, and create your address again.",
    action: "Try another passkey",
  },
  PASSKEY_FAILED: {
    reason: "No passkey answered.",
    box: "No passkey answered",
    meaning: () => "The passkey prompt was cancelled or timed out, or this device has no passkey for this site.",
    recovery: () =>
      "Try again and approve the prompt. If no passkey is offered, use the device where you created your address, or one that syncs its passkeys.",
    action: "Try again",
  },
  NO_KEY_PUBLISHED: {
    reason: "Addressee not in the register.",
    box: "Not in the register",
    meaning: () =>
      "The directory has no key for this address, so there is nothing to seal to. Nothing was sealed and nothing was sent.",
    recovery: () => "Ask them to create their Letterlock address, then seal the note again.",
  },
  EPOCH_MISMATCH: {
    reason: "Key from another epoch.",
    box: "Key from another epoch",
    meaning: (v) =>
      `The envelope is sealed to ${epoch(v.envelopeEpoch, "one epoch")}, and the key in hand is for ${epoch(v.keyEpoch, "another")}.`,
    recovery: (v) =>
      `Open it with your passkey again: it re-derives the key for every earlier epoch, including ${epoch(v.envelopeEpoch, "the one this envelope names")}.`,
    action: "Open with passkey",
  },
  WRONG_KEY: {
    reason: "Sealed to a different passkey.",
    box: "Sealed to another passkey",
    meaning: (v) =>
      key(v.sealedTo) && key(v.derived)
        ? `The envelope did not open. It names key ${key(v.sealedTo)}, and the passkey you chose derives ${key(v.derived)}.`
        : "The envelope did not open, and the key it names is not the one the chosen passkey derives.",
    recovery: () => "Open it again and choose the passkey you used when you created this address.",
    action: "Choose another passkey",
  },
  TAMPERED: {
    reason: "Damaged in transit.",
    box: "Damaged in transit",
    meaning: () =>
      "The envelope failed its authentication check: it was changed after it was sealed. No part of it was decrypted.",
    recovery: () => "Don’t trust this copy. Ask the sender to seal the note again.",
  },
};
