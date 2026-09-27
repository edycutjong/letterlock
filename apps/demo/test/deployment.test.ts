// The header, the footer, /register, /judge and /kit print the directory and its smoke-test keys as real values, with
// no Example stamp, so each of them must be read from the deployment records (deployments/143.json and 10143.json,
// written by the deploys) and none typed into lib/deployment.ts: a typed value outlives the next redeploy. One did:
// after the testnet redeploy, /register paired the new publish transaction and block with the previous directory's key
// time, 7 hours earlier.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

// lib/deployment.ts imports the records as Next.js does, with no import attribute, which Node refuses for JSON. In
// this test process a .json file loads as a module whose default export is the parsed file: the value Next.js gets.
registerHooks({
  load: (url, context, nextLoad) =>
    url.startsWith("file:") && url.endsWith(".json")
      ? { format: "module", source: `export default ${readFileSync(new URL(url), "utf8")};`, shortCircuit: true }
      : nextLoad(url, context),
});

const text = (chain: string) => readFileSync(new URL(`../../../deployments/${chain}.json`, import.meta.url), "utf8");
const mainnet = JSON.parse(text("143"));
const testnet = JSON.parse(text("10143"));
const { DIRECTORY, SMOKE_KEYS, directoryFor, smokeKeysFor } = await import("../lib/deployment.ts");
const { CHAIN, DEPLOYMENT } = await import("../lib/chain.ts");
const { DEPLOYMENTS } = await import("letterlock");

test("the app points at Monad mainnet unless it is built for testnet", () => {
  assert.equal(CHAIN, process.env.NEXT_PUBLIC_LETTERLOCK_CHAIN === "monad-testnet" ? "monad-testnet" : "monad");
  assert.deepEqual(DIRECTORY, directoryFor(CHAIN));
  assert.deepEqual(SMOKE_KEYS, smokeKeysFor(CHAIN));
});

for (const [chain, record] of [
  ["monad", mainnet],
  ["monad-testnet", testnet],
] as const) {
  test(`${chain}: the directory the pages name is the record's, and the SDK's`, () => {
    assert.deepEqual(directoryFor(chain), {
      chainId: record.chainId,
      network: record.network,
      address: record.address,
      explorer: record.explorer.contract,
      verified: record.verified,
      verifier: record.verification.verifier,
      match: record.verification.match.split(" ")[0],
      sourceCheck: record.verification.check,
      agentPathEnabled: !/^0x0{40}$/.test(record.identityRegistry),
      deployBlock: record.block,
    });
    const sdk = DEPLOYMENTS[chain];
    assert.equal(sdk.directory, record.address);
    assert.equal(sdk.deployBlock, BigInt(record.block));
    assert.equal(sdk.chainId, record.chainId);
  });

  test(`${chain}: every smoke-test line is the record's key, timed by its own publish`, () => {
    const keys = smokeKeysFor(chain);
    assert.equal(keys[0]!.recipient, record.deployer.toLowerCase());
    assert.equal(keys[0]!.publicKey, record.smokeTest.publishedKey);
    assert.equal(keys[0]!.fingerprint, record.smokeTest.kid);
    assert.equal(keys[0]!.block, record.smokeTest.publishBlock);
    assert.equal(keys[0]!.txHash, record.publishTx);
    assert.equal(keys[0]!.txUrl, record.explorer.publishTx);
    assert.equal(keys[0]!.updatedAt, record.smokeTest.updatedAt);
    if (chain === "monad") {
      const agent = keys[1]!;
      assert.equal(agent.recipient, `agent:${record.agentId}`);
      assert.equal(agent.publicKey, record.smokeTest.agentKey.publishedKey);
      assert.equal(agent.txHash, record.publishForAgentTx);
      assert.equal(agent.publisher, record.agent.owner);
    } else assert.equal(keys.length, 1, "testnet has no agent path");
  });
}

test("lib/deployment.ts types no chain value: each hex string and long number in it, comments included, is in a record", () => {
  const records = (text("143") + text("10143")).toLowerCase();
  const source = readFileSync(new URL("../lib/deployment.ts", import.meta.url), "utf8").replace(/\b\d{4}-\d{2}-\d{2}\b/g, "");
  const literals = source.match(/\b0x[0-9a-f]+\b|\b[0-9a-f]{16}\b|\b\d{4,}\b/gi) ?? [];
  assert.deepEqual(literals.filter((l) => !records.includes(l.toLowerCase())), []);
});

test("the chain config's directory is the one the records name", () => {
  assert.equal(DEPLOYMENT.directory, (CHAIN === "monad" ? mainnet : testnet).address);
});
