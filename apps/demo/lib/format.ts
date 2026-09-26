// Pure formatting helpers shared by the components. No chain access here.

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** `0x4ccacf66…fa30`-style shortening; strings that are already short are returned unchanged. */
export const shortHex = (hex: string, head = 6, tail = 4): string =>
  hex.length <= head + tail + 1 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;

/** An address line: a 0x address is shortened, an `agent:<id>` recipient is kept whole. */
export const addressLine = (recipient: string): string =>
  ADDRESS.test(recipient) ? shortHex(recipient.toLowerCase(), 6, 4) : recipient;

/** What a screen reader hears for an address line: the full recipient, never the elided form. */
export const addressSpoken = (recipient: string): string =>
  ADDRESS.test(recipient) ? `address ${recipient.toLowerCase()}` : recipient.replace(/^agent:/, "agent ");

/** Block numbers and byte counts with thousands separators, the way an explorer prints them. */
export const formatCount = (n: number): string => n.toLocaleString("en-US");

export const formatBytes = (n: number): string => `${formatCount(n)} ${n === 1 ? "byte" : "bytes"}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `26 Sep 2026, 14:35 UTC`: always UTC, so the server and the browser print the same string. */
export const formatUtc = (unixSeconds: number): string => {
  const d = new Date(unixSeconds * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
};

/** `26 SEP 2026` for a postmark. */
export const postmarkDate = (unixSeconds: number): string => {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]!.toUpperCase()} ${d.getUTCFullYear()}`;
};

/** UTF-8 byte length, the unit the directory's envelope limit is written in. */
export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;
