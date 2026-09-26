import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The SDK ships TypeScript sources (packages/letterlock/src); the app compiles them itself.
  transpilePackages: ["letterlock"],
  // No ESLint in this workspace: `tsc` (next build) and the tests in test/ are the gates.
  eslint: { ignoreDuringBuilds: true },
};

export default config;
