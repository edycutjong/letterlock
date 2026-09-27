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
