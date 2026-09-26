// What "2 · Use my passkey" concludes, as one pure function so every branch is unit-tested (test/verdict.test.ts).
// The level feeds the coloured box and the first line of "Copy result" ("Result: PASS — …"), so only a run that
// actually tested what it claims may say "pass".
export type Verdict = { readonly level: "pass" | "fail" | "retry" | "info"; readonly text: string };

export const HYBRID_HINT = "The passkey was used from ANOTHER device (hybrid / QR), and Safari 18.x can return no PRF output or a different one that way. Wait until the passkey shows in this device's Passwords app, then tap 2 again and pick it here.";

export type Outcome = {
  /** A sealed note came with the link (or from this device's storage). */
  readonly hasNote: boolean;
  /** With no note to open, this tap sealed a new one to the key it derived and put it in the link. */
  readonly sealed?: boolean | undefined;
  /** The note decrypted with the key just derived. */
  readonly opened: boolean;
  /** Opening failed with WRONG_KEY: the note's kid names another key. */
  readonly wrongKey: boolean;
  /** The assertion came from another device over hybrid, or a security key (authenticatorAttachment "cross-platform"). */
  readonly hybrid: boolean;
  /** This device created the passkey the note was sealed to, so the lookup used its credential hint. */
  readonly creator: boolean;
  /** The link's credential ID equals the one that answered; null when the link names none. */
  readonly sameCredential: boolean | null;
  /** The passkey name the link carries. */
  readonly who?: string | undefined;
  /** The test's other device, seen from this one: "iPad" on the Mac, "Mac" on the iPad. */
  readonly other: string;
  /** Any other failure to open: its error code and the words for it. */
  readonly openError?: { readonly code: string; readonly help: string } | undefined;
};

export const deriveVerdict = (o: Outcome): Verdict => {
  if (!o.hasNote && o.sealed) {
    return { level: "info", text: `No note came with this link, so a new note was sealed to this key and put in the link. Tap 2 once more to check that it opens here, then open the link on the ${o.other}: both must show this fingerprint.` };
  }
  if (!o.hasNote) return { level: "info", text: "No note in this link. Compare this fingerprint with your other device by eye." };
  if (o.opened && o.hybrid) {
    // the key is right, but it came from the other device: the synced copy on this one was never used
    return { level: "retry", text: "The note opened, but through ANOTHER device (hybrid / QR), not the passkey synced to this one, so this run does not test the sync. Wait until the passkey shows in this device's Passwords app, then tap 2 again and pick the copy saved here." };
  }
  if (o.opened && o.creator) {
    return { level: "pass", text: `Self-check passed: signing in gives the same key as creating the passkey did, on the device that made it. Now open the link on the ${o.other}.` };
  }
  if (o.opened) return { level: "pass", text: "Same key — the note opened on this device." };
  if (o.hybrid) return { level: "retry", text: HYBRID_HINT };
  if (o.wrongKey && o.creator) {
    // no second device involved: the PRF output at creation differs from the one at sign-in on this device
    return { level: "fail", text: `Same passkey on the device that made it, but a DIFFERENT key: signing in gives another PRF output than creating the passkey did. This is not a sync problem. Please send this result before you test the ${o.other}.` };
  }
  if (o.wrongKey && o.sameCredential === true) {
    return { level: "fail", text: "Same passkey as the other device, but a DIFFERENT key: its PRF output did not match across devices. If the two devices run different OS generations (for example macOS 26 with iPadOS 18), this can be a known Apple issue rather than a Letterlock defect. Please send this result with both OS versions." };
  }
  if (o.wrongKey && o.sameCredential === false) {
    return { level: "retry", text: `A different passkey was chosen. Tap 2 again and choose ${o.who ? `“${o.who}”` : `the passkey the ${o.other} made`}.` };
  }
  if (o.wrongKey) return { level: "fail", text: "Different key: either another passkey was chosen, or the PRF output differs across devices." };
  const e = o.openError ?? { code: "UNEXPECTED", help: "" };
  return { level: "fail", text: `The note did not open (${e.code}). ${e.help}`.trim() };
};
