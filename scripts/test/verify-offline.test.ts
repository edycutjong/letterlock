// scripts/verify_offline.ts end to end, as `pnpm verify` runs it, on the real fixture file and on copies with cases
// taken out: the replay must hold every case scripts/fixtures.ts plans (FIXTURE_CASES), so removing the negative cases,
// or all of them, fails the run instead of shrinking it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FIXTURE_CASES, FIXTURE_FILE } from "../fixtures.ts";

const SCRIPT = fileURLToPath(new URL("../verify_offline.ts", import.meta.url));
let scratch = "";
before(async () => { scratch = await mkdtemp(join(tmpdir(), "letterlock-verify-offline-")); });
after(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

type Result = { failed: number; fixtures: { cases: number; passed: number; planned: number; asPlanned: boolean; outcomes: string[] }; osBlock: { tool: string | null; ok: boolean } };
const verifyOffline = (...args: string[]): Promise<{ code: number | null; out: string; result: Result }> =>
  new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("close", (code) => {
      const line = /^VERIFY_OFFLINE_RESULT (\{.*\})$/m.exec(out)?.[1];
      if (!line) reject(new Error(`no result line (exit ${code}):\n${out}`));
      else resolve({ code, out, result: JSON.parse(line) as Result });
    });
  });

/** A copy of fixtures/envelopes.json with its offline cases edited, written to the scratch folder. */
const variant = async (name: string, edit: (cases: { id: string }[]) => { id: string }[]) => {
  const file = JSON.parse(await readFile(FIXTURE_FILE, "utf8")) as { offline: { id: string }[] };
  file.offline = edit(file.offline);
  const path = join(scratch, `${name}.json`);
  await writeFile(path, JSON.stringify(file));
  return path;
};

test("the fixture file as committed: every planned case replays, each outcome is shown", async () => {
  const r = await verifyOffline();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual([r.result.failed, r.result.fixtures.cases, r.result.fixtures.passed, r.result.fixtures.asPlanned], [0, FIXTURE_CASES.length, FIXTURE_CASES.length, true]);
  assert.deepEqual(new Set(r.result.fixtures.outcomes), new Set(FIXTURE_CASES.map((c) => c.want)));
});

test("the negative cases taken out: the run fails and names each missing case", async () => {
  const dropped = ["tampered-ct", "tampered-enc", "readdressed", "other-chain", "other-directory", "wrong-key", "agent-owner-key", "old-epoch-current-key"];
  const r = await verifyOffline("--fixtures", await variant("no-negatives", (cases) => cases.filter((c) => !dropped.includes(c.id))));
  assert.equal(r.code, 1);
  assert.equal(r.result.fixtures.asPlanned, false);
  const missing = FIXTURE_CASES.map((c) => c.id as string).filter((id) => dropped.includes(id)); // in the planned order
  assert.equal(missing.length, dropped.length);
  assert.match(r.out, new RegExp(`FAIL  the planned cases, each once, in order +missing: ${missing.join(", ")}\n`));
  assert.match(r.out, /FAIL {2}every outcome is shown +no passing case shows WRONG_KEY, EPOCH_MISMATCH/);
});

test("no case at all: the run fails, it does not pass with 0 of 0", async () => {
  const r = await verifyOffline("--fixtures", await variant("empty", () => []));
  assert.equal(r.code, 1);
  assert.equal(r.result.fixtures.cases, 0);
  assert.ok(r.result.failed >= 2, r.out);
});

test("a case repeated in place of another: the run fails", async () => {
  const r = await verifyOffline("--fixtures", await variant("repeated", (cases) => cases.map((c, i) => (i === 1 ? cases[0]! : c))));
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL {2}the planned cases, each once, in order +missing: tampered-ct/);
});

/**
 * A preload that appends `code` to the SDK's entry module as it loads, so the run is the real one with one planted
 * network attempt: nothing in the tree is edited. verify_offline passes execArgv on when it re-runs itself sandboxed.
 */
const planted = async (name: string, code: string) => {
  const hooks = join(scratch, `${name}-hooks.mjs`);
  await writeFile(hooks, `export async function load(url, context, next) {
  const r = await next(url, context);
  return url.endsWith("/packages/letterlock/src/index.ts") ? { ...r, source: String(r.source) + ${JSON.stringify(`\n${code}\n`)} } : r;
}\n`);
  const preload = join(scratch, `${name}.mjs`);
  await writeFile(preload, `import { register } from "node:module";\nregister(${JSON.stringify(new URL(`file://${hooks}`).href)});\n`);
  return preload;
};
const verifyOfflineWith = (preload: string): ReturnType<typeof verifyOffline> =>
  new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", preload, SCRIPT], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("close", (code) => {
      const line = /^VERIFY_OFFLINE_RESULT (\{.*\})$/m.exec(out)?.[1];
      if (!line) reject(new Error(`no result line (exit ${code}):\n${out}`));
      else resolve({ code, out, result: JSON.parse(line) as Result });
    });
  });

test("a network attempt made while the SDK loads fails the run, and is not added to the probes' tally", async () => {
  const r = await verifyOfflineWith(await planted("on-load",
    `void (async () => { try { await fetch("https://rpc.monad.xyz", { method: "POST", body: "{}" }); } catch {} })();`));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL {2}attempts while loading the SDK +fetch https:\/\/rpc\.monad\.xyz/);
  assert.equal((r.result as unknown as { networkAttempts: { whileLoading: number } }).networkAttempts.whileLoading, 1);
});

test("a network attempt left on a timer fails the run: it is counted before the result line, not after it", async () => {
  const r = await verifyOfflineWith(await planted("deferred",
    `setTimeout(() => { globalThis.fetch("https://1.1.1.1/cdn-cgi/trace").catch(() => {}); }, 2500);`));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL {2}attempts during the offline work +fetch https:\/\/1\.1\.1\.1\/cdn-cgi\/trace/);
  const result = r.out.indexOf("VERIFY_OFFLINE_RESULT");
  assert.ok(!r.out.slice(result).includes("network blocked"), "an attempt was made after the result line");
});
