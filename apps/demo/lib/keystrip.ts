// The register strip: a key fingerprint printed as a postal 4-state bar code, the kind sorting machines read off
// an envelope. Every hex digit becomes two bars of two bits each, so the 16 digits of a fingerprint (SDK
// `fingerprint()`: the first 8 bytes of SHA-256 of the public key) make 32 bars. The strip encodes exactly the digits
// printed beside it: two screens showing the same strip hold the same key, and a person can compare keys at a glance
// before reading the digits.

export const FINGERPRINT = /^[0-9a-f]{16}$/;

/** A 4-state bar: two bits, high bit = descender, low bit = ascender. */
export type Bar = "tracker" | "ascender" | "descender" | "full";

export const BARS: readonly Bar[] = ["tracker", "ascender", "descender", "full"];

/** Geometry in strip units: a bar is 2.1 wide on a 4.4 pitch; the tracker spans ±2.4 around the centre line. */
export const STRIP = { width: 2.1, pitch: 4.4, reach: 7, tracker: 2.4 } as const;

export const STRIP_BARS = 32;
export const STRIP_WIDTH = (STRIP_BARS - 1) * STRIP.pitch + STRIP.width;
export const STRIP_HEIGHT = 2 * STRIP.reach;

export const stripBars = (fingerprint: string): Bar[] => {
  if (!FINGERPRINT.test(fingerprint))
    throw new TypeError(`fingerprint must be 16 lower-case hex digits, got ${JSON.stringify(fingerprint)}`);
  return [...fingerprint].flatMap((digit) => {
    const v = parseInt(digit, 16);
    return [BARS[v >> 2]!, BARS[v & 3]!];
  });
};

/** The inverse of stripBars, so a test can prove the strip carries the whole fingerprint. */
export const readStrip = (bars: readonly Bar[]): string => {
  if (bars.length !== STRIP_BARS) throw new TypeError(`a strip has ${STRIP_BARS} bars, got ${bars.length}`);
  let hex = "";
  for (let i = 0; i < bars.length; i += 2) hex += ((BARS.indexOf(bars[i]!) << 2) | BARS.indexOf(bars[i + 1]!)).toString(16);
  return hex;
};

/** Top edge and height of a bar, in strip units, with y = 0 on the centre line. */
export const barExtent = (bar: Bar): { y: number; height: number } => {
  const top = bar === "ascender" || bar === "full" ? -STRIP.reach : -STRIP.tracker;
  const bottom = bar === "descender" || bar === "full" ? STRIP.reach : STRIP.tracker;
  return { y: top, height: bottom - top };
};

/** One SVG path for the whole strip (32 rectangles), so a strip is a single element to colour. */
export const stripPath = (fingerprint: string): string =>
  stripBars(fingerprint)
    .map((bar, i) => {
      const { y, height } = barExtent(bar);
      const x = +(i * STRIP.pitch).toFixed(2);
      return `M${x} ${y}h${STRIP.width}v${height}h-${STRIP.width}Z`;
    })
    .join("");

/** `6b5286d1ad2708a1` → `6b52 86d1 ad27 08a1`: fingerprints are read aloud in groups of four. */
export const groupFingerprint = (fingerprint: string): string => fingerprint.match(/.{1,4}/g)?.join(" ") ?? fingerprint;
