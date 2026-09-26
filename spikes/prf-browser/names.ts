// Passkey names for the cross-device test. The tester reads the name on one device and picks it in the other
// device's passkey sheet, so two passkeys made in the same minute must still have different names. The suffix is
// not a secret; it only has to differ.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o or 1/i/l: read on one screen, picked on another

const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

/** "maya 20:48 · k3f": local time to the minute (to find it later in Passwords) plus 3 random characters. */
export const passkeyName = (now: Date = new Date(), random: (n: number) => Uint8Array = randomBytes): string =>
  `maya ${now.toTimeString().slice(0, 5)} · ${Array.from(random(3), (b) => ALPHABET.charAt(b % ALPHABET.length)).join("")}`;
