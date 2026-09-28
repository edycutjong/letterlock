import type { NextConfig } from "next";

/** Headers on every response, pages and files alike; the pages' Content-Security-Policy is set per request (middleware.ts). */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // passkeys on this origin only; nothing else a page could ask the browser for
  {
    key: "Permissions-Policy",
    value:
      "publickey-credentials-create=(self), publickey-credentials-get=(self), clipboard-write=(self), camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), hid=(), display-capture=(), browsing-topics=()",
  },
];

/**
 * The app's host: the WebAuthn rpId the SDK pins (LETTERLOCK_RP_ID, since SDK 0.1.1), on the owner's own domain.
 * test/hosts.test.ts keeps it equal to the SDK's constant.
 */
export const APP_HOST = "app.letterlock.edycu.dev";

/**
 * The rpId SDK 0.1.0 pinned, still attached to this Vercel project. Every request for the app there, any path and any
 * method, is answered 308 with the same path and query on APP_HOST: no page or file of the app is served there, so no
 * passkey is made under the old rpId, and an old link (a judges' link with its pass, a POST to /api/drip) arrives
 * unchanged at the same app. (Vercel's own paths, such as /_vercel/…, answer on every Vercel host first.)
 * On Vercel the 308 is vercel.json's redirect, which Vercel's router answers before any file or function, the build's
 * /_next/ files included. The rule in redirects() below is the same for any other server; Next.js leaves every path
 * under /_next/ out of the redirects it is given, so alone it would serve the build's files, and its 404 page, there.
 */
export const RETIRED_HOST = "letterlock-app.vercel.app";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // a separate build folder for the testnet build the end-to-end tests run (scripts/e2e.mjs)
  distDir: process.env.LETTERLOCK_DIST_DIR || ".next",
  // The SDK ships TypeScript sources (packages/letterlock/src); the app compiles them itself.
  transpilePackages: ["letterlock"],
  // No ESLint in this workspace: `tsc` (next build) and the tests in test/ are the gates.
  eslint: { ignoreDuringBuilds: true },
  // lib/tokens.ts reads the token sheet when a page renders (every page is rendered per request, for its nonce)
  outputFileTracingIncludes: { "/**": ["./app/tokens.css"] },
  // No page uses next/image, so Vercel's image service stays off: at /_next/image it answered before any redirect,
  // on the retired host too (a 400, or a 308 to the source file rather than to the same path)
  images: { unoptimized: true },
  async redirects() {
    return [
      // first: nothing is served on the retired rpId's host (`has` values are anchored regular expressions)
      { source: "/:path*", has: [{ type: "host", value: RETIRED_HOST.replaceAll(".", "\\.") }], destination: `https://${APP_HOST}/:path*`, permanent: true },
      // the register is also the integrations' verify view: keyOf lookups and the KeyPublished lines, live
      { source: "/integrations/verify", destination: "/register", permanent: false },
    ];
  },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      {
        source: "/api/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default config;
