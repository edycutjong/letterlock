// The footer, /register, /judge and /kit print the directory and its one live key as real values, with no Example
// stamp, so each of them must be read from the deployment record (deployments/10143.json, written by the deploy) and
// none typed into lib/deployment.ts: a typed value outlives the next redeploy. One did: after the testnet redeploy,
// /register paired the new publish transaction and block with the previous directory's key time, 7 hours earlier.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

// lib/deployment.ts imports the record as Next.js does, with no import attribute, which Node refuses for JSON. In
// this test process a .json file loads as a module whose default export is the parsed file: the value Next.js gets.
registerHooks({
  load: (url, context, nextLoad) =>
    url.startsWith("file:") && url.endsWith(".json")
      ? { format: "module", source: `export default ${readFileSync(new URL(url), "utf8")};`, shortCircuit: true }
      : nextLoad(url, context),
});

const recordText = readFileSync(new URL("../../../deployments/10143.json", import.meta.url), "utf8");
const record = JSON.parse(recordText);
const { DIRECTORY, TESTNET_TEST_KEY } = await import("../lib/deployment.ts");

test("the live register line is the record's smoke-test key, timed by its own publish", () => {
  assert.deepEqual(TESTNET_TEST_KEY, {
    address: record.deployer,
    publicKey: record.smokeTest.publishedKey,
    epoch: record.smokeTest.epoch,
    fingerprint: record.smokeTest.kid,
    block: record.smokeTest.publishBlock,
    txHash: record.publishTx,
    txUrl: record.explorer.publishTx,
    updatedAt: record.smokeTest.updatedAt,
  });
});

test("the directory the header, footer, /register and /judge name is the record's", () => {
  assert.deepEqual(DIRECTORY, {
    chainId: record.chainId,
    network: record.network,
    address: record.address,
    explorer: record.explorer.contract,
    verified: record.verified,
    verifier: record.verification.verifier,
    match: record.verification.match.split(" ")[0],
    sourceCheck: record.verification.check,
    agentPathEnabled: !/^0x0{40}$/.test(record.identityRegistry),
  });
});

test("lib/deployment.ts types no chain value: each hex string and long number in it, comments included, is in the record", () => {
  const source = readFileSync(new URL("../lib/deployment.ts", import.meta.url), "utf8").replace(/\b\d{4}-\d{2}-\d{2}\b/g, "");
  const literals = source.match(/\b0x[0-9a-f]+\b|\b[0-9a-f]{16}\b|\b\d{4,}\b/gi) ?? [];
  assert.deepEqual(literals.filter((l) => !recordText.toLowerCase().includes(l.toLowerCase())), []);
});
