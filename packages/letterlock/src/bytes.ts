const enc = new TextEncoder();

export const utf8 = (s: string): Uint8Array => enc.encode(s);

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** Unsigned big-endian integer of `width` bytes. Throws if it does not fit. */
export const uintBE = (value: number | bigint, width: number): Uint8Array => {
  let v = BigInt(value);
  if (v < 0n || v >= 1n << BigInt(8 * width)) throw new RangeError(`${value} does not fit in ${width} bytes`);
  const out = new Uint8Array(width);
  for (let i = width - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
};

/** 2-byte length prefix, so concatenated fields can never be re-split differently. */
export const lp = (b: Uint8Array): Uint8Array => concat(uintBE(b.length, 2), b);

export const toB64url = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const fromB64url = (s: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new TypeError("not base64url");
  if (s.length % 4 === 1) throw new TypeError("not base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  // reject non-canonical encodings (unused trailing bits set): one byte string ↔ exactly one string
  if (toB64url(out) !== s) throw new TypeError("non-canonical base64url");
  return out;
};

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const fromHex = (h: string): Uint8Array => {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new TypeError("not hex");
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
};
