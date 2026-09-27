// The page's Content-Security-Policy. This origin is the WebAuthn rpId every Letterlock key is derived under
// (docs/SPEC.md §6): a script injected here could run passkey ceremonies for it, so scripts run only with the
// per-request nonce (and what those scripts load, 'strict-dynamic'), and the page may connect only to the Monad RPCs,
// the reference agent and the Sourcify server it reads. No analytics, no third-party script, no frames.
import { AGENT_URL, RPC_URL, SCAN_RPC_URL, SOURCE_CHECK_URL } from "./endpoints.ts";

const origin = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/** Everywhere the page's own scripts fetch from, besides itself. */
export const CONNECT_SOURCES = [...new Set([RPC_URL, SCAN_RPC_URL, AGENT_URL, SOURCE_CHECK_URL].map(origin).filter((o): o is string => !!o))];

export const contentSecurityPolicy = (nonce: string, o: { dev: boolean; https: boolean }): string =>
  [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${o.dev ? " 'unsafe-eval'" : ""}`,
    // style attributes (React's style={}) cannot carry a nonce; stylesheets come from this origin
    "style-src 'self' 'unsafe-inline'",
    // data: for the paper grain (an SVG in the stylesheet)
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${CONNECT_SOURCES.join(" ")}${o.dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
    ...(o.https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
