// The contracts README, the smoke script and the deployment records (deployments/*.json) describe the same deploys.
// These tests keep what they say in step with the records: where each deploy gas limit came from.
//
//   node --test contracts/script/records.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const repo = join(import.meta.dirname, "..", "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const mainnet = JSON.parse(read("deployments/143.json"));
const testnet = JSON.parse(read("deployments/10143.json"));
const readme = read("contracts/README.md").replace(/\s+/g, " "); // sentences run across line breaks
const num = (s) => Number(s.replaceAll(",", ""));
const fmt = (n) => n.toLocaleString("en-US");
/** "1.3 × <estimate> = <limit> on <network>", as the README states it */
const deployGas = (name) => {
  const m = readme.match(new RegExp(`1\\.3 × ([\\d,]+) = ([\\d,]+) on ${name}`));
  assert.ok(m, `the README states the ${name} deploy estimate and limit`);
  return { estimate: num(m[1]), limit: num(m[2]) };
};

test("each deploy gas limit is forge's 1.3 x eth_estimateGas, rounded down, from the estimate the README states", () => {
  for (const [name, record] of [["mainnet", mainnet], ["testnet", testnet]]) {
    const { estimate, limit } = deployGas(name);
    assert.equal(limit, record.gasUsed.deploy, `${name} limit`);
    assert.equal(Math.floor((estimate * 130) / 100), record.gasUsed.deploy, `${name}: 1.3 x ${estimate}`);
  }
});

test("the README's split of the registry argument's extra deploy gas adds up", () => {
  const extra = deployGas("mainnet").estimate - deployGas("testnet").estimate;
  assert.match(readme, new RegExp(`The registry argument adds ${fmt(extra)} gas to the estimate`));
  // calldata: 16 gas per non-zero byte, 4 per zero byte; the testnet argument, address(0), is 32 zero bytes
  const word = mainnet.identityRegistry.slice(2).toLowerCase().padStart(64, "0").match(/../g);
  const calldata = word.reduce((g, b) => g + (b === "00" ? 4 : 16), 0) - 32 * 4;
  const coldAccess = 10_100; // Monad's cold account access, which EXTCODESIZE pays on a first touch
  assert.match(readme, new RegExp(`${fmt(coldAccess)} is the constructor's \`registry\\.code\\.length\` check`));
  assert.match(readme, new RegExp(`and ${fmt(calldata)} is calldata`));
  assert.ok(coldAccess + calldata <= extra);
  assert.doesNotMatch(readme, /cheaper calldata/);
});
