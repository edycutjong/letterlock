// Which actions the home page offers (app/AddressDesk.tsx), from what this device and the register show. Sealing a note
// to your address and opening its inbox follow only from a key the register holds: a register that could not be read,
// or is still being read, says nothing either way, so it never offers them.
import type { KeyOfState } from "./hooks.ts";

export type HomeAction =
  /** the page has not read this device yet (hydration): the create button, disabled */
  | "wait"
  /** not the passkey host: a link to the live site */
  | "elsewhere"
  /** a create or a post is under way: its button, waiting */
  | "running"
  /** no passkey on this device: create an address */
  | "create"
  /** a passkey on this device, and no key of its account in the register (or no account yet): post it */
  | "post"
  /** the account's key is in the register: seal a note to it, open its inbox */
  | "found"
  /** the register could not be read, so whether the key is posted is not known: post it, or read the register again */
  | "unknown"
  /** the register is being read: the status line only */
  | "reading";

export type HomeState = {
  readonly host: "pending" | "ok" | "elsewhere";
  readonly stored: "pending" | "none" | "stored";
  /** the stored passkey's account address is known */
  readonly address: boolean;
  readonly register: KeyOfState["status"];
  readonly running?: "create" | "post" | "rotate";
};

export const homeAction = (s: HomeState): HomeAction => {
  if (s.host === "pending" || s.stored === "pending") return "wait";
  if (s.host === "elsewhere") return "elsewhere";
  if (s.running && s.running !== "rotate") return "running";
  if (s.stored === "none") return "create";
  if (!s.address || s.register === "none") return "post";
  if (s.register === "found") return "found";
  if (s.register === "failed") return "unknown";
  return "reading";
};
