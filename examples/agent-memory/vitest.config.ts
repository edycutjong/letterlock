import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // test/chain.test.ts runs the agent against the real directory bytecode on a local anvil (chain id 143, a test-double
    // ERC-8004 registry at the mainnet address): the SDK's own chain harness, reused as it is. Without forge and anvil
    // on PATH those tests skip with the reason.
    globalSetup: ["../../packages/letterlock/test/anvil/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
