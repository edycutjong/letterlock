// The note's size limit is in UTF-8 bytes: the bytes decide how dense the hand-off QR code gets. A character
// limit would promise too much, because emoji and Chinese, Japanese or Korean characters take 3–4 bytes each.
export const MAX_NOTE_BYTES = 200; // keeps the hand-off QR code small enough to scan off a laptop screen

export type NoteBudget = { readonly bytes: number; readonly max: number; readonly ok: boolean; readonly text: string };

export const noteBytes = (note: string): number => new TextEncoder().encode(note).length;

/** What the live counter under the note field says about `note` (already trimmed). */
export const noteBudget = (note: string): NoteBudget => {
  const bytes = noteBytes(note);
  const ok = bytes <= MAX_NOTE_BYTES;
  const text = bytes === 0
    ? `0 / ${MAX_NOTE_BYTES} bytes: empty, so the sample note is sealed`
    : ok ? `${bytes} / ${MAX_NOTE_BYTES} bytes`
      : `${bytes} / ${MAX_NOTE_BYTES} bytes: too long. Emoji and Chinese, Japanese or Korean characters take 3–4 bytes each.`;
  return { bytes, max: MAX_NOTE_BYTES, ok, text };
};
