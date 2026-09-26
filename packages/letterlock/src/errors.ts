/** The protocol's error codes (docs/SPEC.md §5): derivation, sealing, opening and the directory's "no key". */
export type LetterlockErrorCode =
  | "PRF_UNSUPPORTED"
  | "NO_KEY_PUBLISHED"
  | "TAMPERED"
  | "EPOCH_MISMATCH"
  | "WRONG_KEY"
  | "PASSKEY_FAILED"
  | "INPUT_INVALID";

/** Codes only the chain client raises (resolve, publish, drop, inbox): docs/SPEC.md §5, "Chain client". */
export type ChainErrorCode =
  | "NOT_AGENT_OWNER"
  | "INSUFFICIENT_FUNDS"
  | "CHAIN_UNAVAILABLE";

export class LetterlockError extends Error {
  readonly code: LetterlockErrorCode | ChainErrorCode;
  constructor(code: LetterlockErrorCode | ChainErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "LetterlockError";
    this.code = code;
  }
}

export const isLetterlockError = (e: unknown, code?: LetterlockErrorCode | ChainErrorCode): e is LetterlockError =>
  e instanceof LetterlockError && (code === undefined || e.code === code);
