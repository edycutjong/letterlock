// scripts/seed.ts end to end on a local chain: anvil (chain id 10143, as Monad testnet, the script's default) runs the
// directory compiled from contracts/src/Letterlock.sol, two personas publish software keys (Kai rotates once), and the
// script runs as a child process exactly as `pnpm seed` runs it. Every envelope it drops is read back from the
// directory's logs and opened with the persona's key: the four notes open to the plan's texts, the tampered copy is
// TAMPERED, and the old-epoch note opens with Kai's epoch-1 key and is EPOCH_MISMATCH with his epoch-2 key. Each
// refusal is checked to send nothing (the sender's nonce does not move).
//
// No key is written in this file: the sender and the personas get fresh random keys, funded with anvil_setBalance. The
// software keys are the fixtures' (scripts/lib/plan.ts); on a real chain the personas' keys come from their passkeys.
// Without forge and anvil on PATH the tests skip with the reason; LETTERLOCK_REQUIRE_ANVIL=1 fails instead.
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isLetterlockError, letterlock, letterlockAbi, open } from "letterlock";
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { SEED_NOTES, SEED_OLD_EPOCH, SEED_TAMPER, fixtureKeys } from "../lib/plan.ts";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONTRACTS = join(ROOT, "contracts");
const SEED = join(ROOT, "scripts/seed.ts");
/** anvil's first default account, unlocked by anvil itself: it deploys the directory (forge create --unlocked). */
const ANVIL_DEPLOYER: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const toolsMissing = await run("forge", ["--version"]).then(() => run("anvil", ["--version"])).then(() => undefined, (e: Error) => e.message);
if (toolsMissing && process.env.LETTERLOCK_REQUIRE_ANVIL === "1") throw new Error(`forge and anvil are required: ${toolsMissing}`);
const skip = toolsMissing ? `forge and anvil (Foundry) are needed: ${toolsMissing}` : false;

let anvil: ChildProcess | undefined;
let scratch = "";
let url = "";
let directory: Address;
let deployBlock = 0n;
const sender = generatePrivateKey();
const maya = privateKeyToAccount(generatePrivateKey());
const kai = privateKeyToAccount(generatePrivateKey());
const nobody = privateKeyToAccount(generatePrivateKey()).address;

const chain = () => ({ ...monadTestnet, rpcUrls: { default: { http: [url] } } });
const client = () => letterlock({ chain: "monad-testnet", rpcUrl: url, directory, deployBlock, unsafeAllowAnyRpId: true, pollingInterval: 50 });
const nonce = () => createPublicClient({ chain: chain(), transport: http(url) }).getTransactionCount({ address: privateKeyToAccount(sender).address });

/** Runs scripts/seed.ts as `pnpm seed` does, against the local chain, with the sender's key in SEED_TEST_KEY only. */
const seedAs = (key: Hex, ...args: string[]): Promise<{ code: number; out: string; err: string }> =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [SEED, "--rpc", url, "--directory", directory, "--from-block", "0", "--record", join(scratch, "seeded.json"),
      "--private-key-env", "SEED_TEST_KEY", ...args], { env: { ...process.env, SEED_TEST_KEY: key }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    p.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
const seed = (...args: string[]) => seedAs(sender, ...args);

before(async () => {
  if (skip) return;
  scratch = await mkdtemp(join(tmpdir(), "letterlock-seed-test-"));
  const build = ["--root", CONTRACTS, "--out", join(scratch, "out"), "--cache-path", join(scratch, "cache")];
  await run("forge", ["build", ...build, "src/Letterlock.sol"], { cwd: CONTRACTS, maxBuffer: 1 << 24 });
  url = await new Promise<string>((resolve, reject) => {
    const proc = spawn("anvil", ["--port", "0", "--chain-id", "10143", "--slots-in-an-epoch", "1"], { stdio: ["ignore", "pipe", "pipe"] });
    anvil = proc;
    let seen = "";
    const timer = setTimeout(() => reject(new Error(`anvil did not start: ${seen.slice(-400)}`)), 20_000);
    proc.stdout!.on("data", (d: Buffer) => {
      seen += d.toString();
      const m = /Listening on ([0-9.]+:\d+)/.exec(seen);
      if (m) { clearTimeout(timer); resolve(`http://${m[1]}`); }
    });
  });
  const { stdout } = await run("forge", ["create", ...build, "src/Letterlock.sol:Letterlock", "--rpc-url", url, "--unlocked", "--from", ANVIL_DEPLOYER,
    "--broadcast", "--json", "--constructor-args", "0x0000000000000000000000000000000000000000"], { cwd: CONTRACTS, maxBuffer: 1 << 24 });
  const created = JSON.parse(stdout.slice(stdout.indexOf("{"))) as { deployedTo: Address; transactionHash: Hex };
  directory = created.deployedTo;
  deployBlock = (await createPublicClient({ chain: chain(), transport: http(url) }).getTransactionReceipt({ hash: created.transactionHash })).blockNumber;

  const testClient = createTestClient({ mode: "anvil", chain: chain(), transport: http(url) });
  for (const a of [privateKeyToAccount(sender).address, maya.address, kai.address]) await testClient.setBalance({ address: a, value: parseEther("10") });
  const ll = client();
  await ll.publish({ account: maya, keys: fixtureKeys("maya", 1) });
  await ll.publish({ account: kai, keys: fixtureKeys("kai", 1) });
  await ll.publish({ account: kai, keys: fixtureKeys("kai", 2) }); // Kai rotates: his epoch-1 key is now an old one
});

after(async () => {
  anvil?.kill();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const outcome = async (envelope: Parameters<typeof open>[0], keys: Parameters<typeof open>[1]) => {
  try { return { outcome: "OPENS", text: new TextDecoder().decode(await open(envelope, keys)) }; }
  catch (e) { if (isLetterlockError(e)) return { outcome: e.code }; throw e; }
};

test("--mainnet without --confirm-mainnet is refused before anything is read or sent", { skip }, async () => {
  const r = await seed("--mainnet", "--to", maya.address, "--rpc", "http://127.0.0.1:9");
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /--confirm-mainnet/);
});

test("--directory with --mainnet is refused before anything is read or sent: mainnet notes go to the recorded directory", { skip }, async () => {
  const r = await seedAs(sender, "--mainnet", "--confirm-mainnet", "--to", maya.address, "--rpc", "http://127.0.0.1:9");
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /--directory is for a local test deploy/);
});

test("the plan reaches the personas: the notes open, the copy is TAMPERED, the old-epoch note opens only at its own epoch", { skip }, async () => {
  const before = await nonce();
  const r = await seed("--to", maya.address, "--old-epoch-to", kai.address);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.equal(await nonce(), before + SEED_NOTES.length + 2, "one transaction per planned drop");

  const record = JSON.parse(await readFile(join(scratch, "seeded.json"), "utf8")) as { runs: { status: string; drops: { id: string; recipient: string; tx: Hex; epoch: number }[] }[] };
  assert.equal(record.runs.length, 1);
  assert.match(record.runs[0]!.status, /^sent and read back: all 6 envelopes/);
  assert.deepEqual(record.runs.at(-1)!.drops.map((d) => d.id), [...SEED_NOTES.map((n) => n.id), `${SEED_TAMPER.from}-tampered`, SEED_OLD_EPOCH.id]);

  const ll = client();
  const mayaBox = await ll.inbox(maya.address, { toBlock: "latest" });
  assert.equal(mayaBox.rejected.length, 0);
  const mayaKey = fixtureKeys("maya", 1);
  const opened = await Promise.all(mayaBox.envelopes.map((e) => outcome(e.envelope, mayaKey)));
  assert.deepEqual(opened, [...SEED_NOTES.map((n) => ({ outcome: "OPENS", text: n.text })), { outcome: "TAMPERED" }]);
  assert.deepEqual(mayaBox.envelopes.map((e) => e.transactionHash), record.runs.at(-1)!.drops.slice(0, SEED_NOTES.length + 1).map((d) => d.tx));

  const kaiBox = await ll.inbox(kai.address, { toBlock: "latest" });
  assert.equal(kaiBox.envelopes.length, 1);
  const old = kaiBox.envelopes[0]!.envelope;
  assert.equal(old.epoch, 1);
  assert.deepEqual(await outcome(old, fixtureKeys("kai", 1)), { outcome: "OPENS", text: SEED_OLD_EPOCH.text });
  assert.deepEqual(await outcome(old, fixtureKeys("kai", 2)), { outcome: "EPOCH_MISMATCH" });
  assert.match(r.out, /read back .*: 5 of 5 envelopes in its inbox, byte for byte/);
});

test("a second run to the same persona is refused unless --again, and sends nothing", { skip }, async () => {
  const before = await nonce();
  const r = await seed("--to", maya.address);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /already has a run to .* pass --again/);
  assert.equal(await nonce(), before);
});

test("--dry-run resolves, seals and simulates, and sends and records nothing", { skip }, async () => {
  const before = await nonce();
  const recordBefore = readFileSync(join(scratch, "seeded.json"), "utf8");
  const r = await seed("--to", maya.address, "--old-epoch-to", kai.address, "--dry-run");
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.out, /dry run: nothing sent, nothing recorded/);
  assert.equal(await nonce(), before);
  assert.equal(readFileSync(join(scratch, "seeded.json"), "utf8"), recordBefore);
});

test("a persona that has not rotated cannot take the old-epoch note, and nothing is sent", { skip }, async () => {
  const before = await nonce();
  const r = await seed("--to", maya.address, "--old-epoch-to", maya.address, "--again");
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /has not rotated/);
  assert.equal(await nonce(), before);
});

test("a persona with no published key is NO_KEY_PUBLISHED, and nothing is sent", { skip }, async () => {
  const before = await nonce();
  const r = await seed("--to", nobody, "--again");
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /NO_KEY_PUBLISHED/);
  assert.equal(await nonce(), before);
});

test("a recipient holding the deploy smoke test's key is refused, and nothing is sent: its stand-in is the operator's, not a persona's", { skip }, async () => {
  const record = JSON.parse(readFileSync(join(ROOT, "deployments/10143.json"), "utf8")) as { smokeTest: { publishedKey: Hex } };
  const holder = privateKeyToAccount(generatePrivateKey());
  await createTestClient({ mode: "anvil", chain: chain(), transport: http(url) }).setBalance({ address: holder.address, value: parseEther("1") });
  const wallet = createWalletClient({ account: holder, chain: chain(), transport: http(url) });
  const hash = await wallet.writeContract({ address: directory, abi: letterlockAbi, functionName: "publish", args: [record.smokeTest.publishedKey, 1] });
  await createPublicClient({ chain: chain(), transport: http(url) }).waitForTransactionReceipt({ hash });
  const before = await nonce();
  const r = await seed("--to", holder.address, "--again");
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /epoch-1 key is the deploy smoke test's key \(deployments\/10143\.json\)/);
  assert.equal(await nonce(), before);
});

test("a sender without twice the estimated gas is refused before the first drop", { skip }, async () => {
  const poor = generatePrivateKey();
  await createTestClient({ mode: "anvil", chain: chain(), transport: http(url) }).setBalance({ address: privateKeyToAccount(poor).address, value: 1_000_000n });
  const r = await seedAs(poor, "--to", maya.address, "--again");
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /asks for twice that\nnothing was sent/);
  assert.equal(await createPublicClient({ chain: chain(), transport: http(url) }).getTransactionCount({ address: privateKeyToAccount(poor).address }), 0);
});
