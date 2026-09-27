// scripts/verify.ts's own rules: when a step passes, and how each runner's report is counted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { offline, stepError, tap, unittest, type Counts } from "../verify.ts";

const counts = (passed: number, failed: number, skipped: number): Counts => ({ passed, failed, skipped, total: passed + failed + skipped, notes: [] });

test("a step passes only when it exits 0, fails no test and passes at least one", () => {
  assert.equal(stepError(0, counts(229, 0, 0)), undefined);
  assert.equal(stepError(0, counts(1, 0, 7)), undefined);
  // every test skipped: vitest -t with a name nothing matches, or the anvil tests without Foundry
  assert.equal(stepError(0, counts(0, 0, 229)), "no test passed (229 skipped)");
  assert.equal(stepError(0, counts(0, 0, 7)), "no test passed (7 skipped)");
  assert.equal(stepError(0, counts(0, 0, 0)), "ran no test");
  assert.equal(stepError(0, counts(5, 1, 0)), "1 failed");
  assert.equal(stepError(1, counts(5, 0, 0)), "exit code 1");
  assert.equal(stepError(0, undefined, "no JSON"), "counts unreadable: no JSON");
});

test("node:test's TAP summary is counted, a skipped test is not a pass", () => {
  const out = ["TAP version 13", "ok 1 - a", "ok 2 - b # SKIP no anvil", "not ok 3 - c", "1..3",
    "# tests 3", "# suites 0", "# pass 1", "# fail 1", "# cancelled 0", "# skipped 1", "# todo 0"].join("\n");
  const c = tap(out);
  assert.deepEqual([c.passed, c.failed, c.skipped, c.total], [1, 1, 1, 3]);
  assert.deepEqual(c.notes, ["FAILED c", "skipped b: no anvil"]);
  const allSkipped = tap(["ok 1 - a # SKIP x", "# tests 1", "# pass 0", "# fail 0", "# cancelled 0", "# skipped 1", "# todo 0"].join("\n"));
  assert.equal(stepError(0, allSkipped), "no test passed (1 skipped)");
});

test("unittest's summary is counted: OK, OK with skips, FAILED with failures and errors", () => {
  const ok = unittest("test_a (test_x.T.test_a) ... ok\ntest_b (test_x.T.test_b) ... skipped 'no git'\n\n" +
    "----------------------------------------------------------------------\nRan 2 tests in 0.004s\n\nOK (skipped=1)\n");
  assert.deepEqual([ok.passed, ok.failed, ok.skipped, ok.total], [1, 0, 1, 2]);
  assert.deepEqual(ok.notes, ["skipped test_x.T.test_b: no git"]);
  const bad = unittest("test_a (test_x.T.test_a) ... FAIL\ntest_b (test_x.T.test_b) ... ERROR\ntest_c (test_x.T.test_c) ... ok\n\n" +
    "======================================================================\nFAIL: test_a (test_x.T.test_a)\n----\nAssertionError\n" +
    "======================================================================\nERROR: test_b (test_x.T.test_b)\n----\nKeyError\n" +
    "----------------------------------------------------------------------\nRan 3 tests in 0.010s\n\nFAILED (failures=1, errors=1)\n");
  assert.deepEqual([bad.passed, bad.failed, bad.skipped, bad.total], [1, 2, 0, 3]);
  assert.deepEqual(bad.notes, ["FAILED test_x.T.test_a", "FAILED test_x.T.test_b"]);
  const none = unittest("\n----------------------------------------------------------------------\nRan 0 tests in 0.000s\n\nNO TESTS RAN\nOK\n");
  assert.equal(stepError(0, none), "ran no test");
  assert.throws(() => unittest("Traceback (most recent call last):\nImportError"), /no "Ran N tests" line/);
});

test("verify_offline's result line: the OS block, the probes and the fixture replay are reported", () => {
  const line = `VERIFY_OFFLINE_RESULT ${JSON.stringify({
    checks: 71, passed: 71, failed: 0,
    osBlock: { tool: "sandbox-exec", ok: true, detail: "no network under sandbox-exec: TCP EPERM, UDP EPERM, DNS ENOTFOUND" },
    fixtures: { cases: 14, passed: 14, planned: 14 }, roundTrips: 9,
    networkAttempts: { probes: 37, probesRefused: 37, refusedProbes: 52, duringOfflineWork: 0 }, maxPlaintextBytes: 12099,
  })}`;
  const c = offline(`noise\n${line}\n`);
  assert.deepEqual([c.passed, c.failed, c.total], [71, 0, 71]);
  assert.deepEqual(c.notes, [
    "OS-level network block: no network under sandbox-exec: TCP EPERM, UDP EPERM, DNS ENOTFOUND",
    "fixture replay 14/14 of 14 planned (fixtures/envelopes.json), 9 round trips to cached keys",
    "37 of 37 ways out refused in-process (52 attempts counted), 0 attempts during the offline work",
  ]);
  const bare = offline(line.replace(/"osBlock":\{[^}]*\},/, '"osBlock":{"tool":null,"ok":true,"detail":"none on this machine (no sandbox)"},'));
  assert.equal(bare.notes[0], "no OS-level network block: none on this machine (no sandbox)");
});
