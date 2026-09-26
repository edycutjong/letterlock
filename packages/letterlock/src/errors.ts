export type LetterlockErrorCode =
  | "PRF_UNSUPPORTED"
  | "NO_KEY_PUBLISHED"
  | "TAMPERED"
  | "EPOCH_MISMATCH"
  | "INPUT_INVALID";

export class LetterlockError extends Error {
  readonly code: LetterlockErrorCode;
  constructor(code: LetterlockErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "LetterlockError";
    this.code = code;
  }
}

export const isLetterlockError = (e: unknown, code?: LetterlockErrorCode): e is LetterlockError =>
  e instanceof LetterlockError && (code === undefined || e.code === code);
