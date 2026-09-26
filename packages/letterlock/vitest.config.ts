import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // anvil + `forge create` for the chain tests (test/anvil/global-setup.ts)
    globalSetup: ["test/anvil/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
