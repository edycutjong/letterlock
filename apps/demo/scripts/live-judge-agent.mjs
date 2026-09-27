// The judge's step 2 on the production site, once, on Monad MAINNET: /judge asks the reference agent to write to an
// address that has a key, from the page (POST /remember to the agent URL this build names, so the agent sees the
// app's origin), and the agent seals the note and drops it from its own wallet. No passkey is made or used, and the
// drip is not asked: the page is given the address as the device that made it would store it (with a made-up
// credential id, never used). It spends one drop from the agent's wallet, so it records the run in
// e2e-results/judge-agent-live.json and refuses a second one without --again.
//
//   node scripts/live-judge-agent.mjs --ask-the-agent-once <an address with a published key> [--again]
//   node scripts/live-judge-agent.mjs --verify <drop transaction> --to <address>     read-only: the checks below
//                                                                                    for a drop already sent
//
// Checked, each fact read back from rpc.monad.xyz: the page's POST went to the agent URL with the app's origin; the
// drop landed, sent by the agent's wallet to the directory; its Dropped event names the address and carries an
// envelope for this chain, this directory, the address, and the epoch and kid of the key keyOf returns for it, the
// same envelope the agent answered the page with; and the app's inbox for the address lists the letter.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LETTERLOCK_RP_ID, VERSION, decodeEnvelope, letterlock, letterlockAbi } from "letterlock";
import { chromium } from "playwright";
import { createPublicClient, decodeEventLog, http } from "viem";
import { monad } from "viem/chains";

const here = join(import.meta.dirname, "..");
const BASE = `https://${LETTERLOCK_RP_ID}`;
const RPC = "https://rpc.monad.xyz";
const AGENT_WALLET = "0xDE8a4A3c3bE2802bf9Be78cfC1de1a5a0A4c47a4";
const record = JSON.parse(readFileSync(join(here, "../../deployments/143.json"), "utf8"));
const out = join(here, "e2e-results/judge-agent-live.json");

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const verifyOnly = arg("--verify");
const address = verifyOnly ? arg("--to") : arg("--ask-the-agent-once");
if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || (verifyOnly && !/^0x[0-9a-fA-F]{64}$/.test(verifyOnly))) {
  console.error("this run spends a drop from the agent's wallet on Monad mainnet: pass --ask-the-agent-once <address with a published key>\n(or --verify <drop transaction> --to <address>: read-only)");
  process.exit(2);
}
const previous = existsSync(out)
  ? JSON.parse(readFileSync(out, "utf8"))
  : { about: "The judge's step 2 on the production site on Monad mainnet (scripts/live-judge-agent.mjs): /judge asks the reference agent from the page to write to an address with a key; no passkey is made or used. Each run spends one of the agent's drops.", runs: [] };
if (!verifyOnly && previous.runs.some((r) => !r.verifiedOnly) && !process.argv.includes("--again")) {
  console.error(`${out} records a run: each spends a drop. Pass --again only on purpose.`);
  process.exit(2);
}

const chain = createPublicClient({ chain: monad, transport: http(RPC) });
const key = await letterlock({ chain: "monad" }).resolve(address); // NO_KEY_PUBLISHED: the agent would refuse it too
const result = {
  site: BASE, rpId: LETTERLOCK_RP_ID, sdk: VERSION, network: record.network, chainId: record.chainId, directory: record.address, recipient: address,
  ...(verifyOnly ? { verifiedOnly: true, dropTx: verifyOnly } : {}),
  startedAt: new Date().toISOString(), steps: {},
};
const step = (name, value) => {
  result.steps[name] = value;
  console.log(`ok   ${name}: ${JSON.stringify(value)}`);
};
const save = () => writeFileSync(out, `${JSON.stringify({ ...previous, runs: [...previous.runs, result] }, null, 2)}\n`);

/** The drop, read back: from the agent's wallet to the directory, one Dropped event to `address`, sealed to its key. */
const checkDrop = async (dropTx, answeredEnvelope) => {
  const [tx, receipt] = await Promise.all([chain.getTransaction({ hash: dropTx }), chain.getTransactionReceipt({ hash: dropTx })]);
  assert.equal(receipt.status, "success");
  assert.equal(tx.from.toLowerCase(), AGENT_WALLET.toLowerCase(), "sent by the agent's wallet");
  assert.equal(tx.to?.toLowerCase(), record.address.toLowerCase(), "the drop was sent to the directory");
  const events = receipt.logs
    .filter((l) => l.address.toLowerCase() === record.address.toLowerCase())
    .map((l) => decodeEventLog({ abi: letterlockAbi, data: l.data, topics: l.topics }))
    .filter((e) => e.eventName === "Dropped");
  assert.equal(events.length, 1, "one Dropped event");
  assert.equal(events[0].args.to.toLowerCase(), address.toLowerCase(), "dropped to the address");
  const onChain = Buffer.from(events[0].args.envelope.slice(2), "hex").toString("utf8");
  const env = decodeEnvelope(onChain);
  assert.deepEqual([env.chainId, env.directory.toLowerCase(), env.recipient, env.epoch, env.kid], [record.chainId, record.address.toLowerCase(), address.toLowerCase(), key.epoch, key.kid]);
  if (answeredEnvelope !== undefined)
    assert.deepEqual(JSON.parse(onChain), typeof answeredEnvelope === "string" ? JSON.parse(answeredEnvelope) : answeredEnvelope, "the envelope on chain is the one the agent answered with");
  return {
    agentDropTx: dropTx,
    agentDropBlock: Number(receipt.blockNumber),
    agentWallet: tx.from,
    gasUsed: Number(receipt.gasUsed),
    envelopeBytes: Buffer.byteLength(onChain),
    sealedTo: { epoch: env.epoch, kid: env.kid, keyOfEpoch: key.epoch, keyOfKid: key.kid },
  };
};

const browser = await chromium.launch();
const problems = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const stored = { v: 1, chainId: record.chainId, rpId: LETTERLOCK_RP_ID, credentialId: "AAAAAAAAAAAAAAAAAAAAAA", address };
  await context.addInitScript(([k, v]) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  }, [`letterlock:v1:${record.chainId}:${LETTERLOCK_RP_ID}`, JSON.stringify(stored)]);
  await context.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)));
  const page = await context.newPage();
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });

  let dropTx = verifyOnly;
  if (!verifyOnly) {
    const calls = [];
    // request.headers() leaves out the Origin header; allHeaders() carries every header the browser sent
    page.on("request", async (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/remember") calls.push({ url: r.url(), origin: (await r.allHeaders()).origin ?? null });
    });
    await page.goto(`${BASE}/judge`, { waitUntil: "domcontentloaded" });
    const ask = page.getByRole("button", { name: "Ask the agent" });
    await page.getByRole("textbox", { name: "What should it remember?" }).and(page.locator(":not([disabled])")).waitFor({ timeout: 45_000 });
    const text = `Judge step 2 on ${LETTERLOCK_RP_ID} (${new Date().toISOString()}): the dentist moved to Thursday at 10:40.`;
    await page.getByRole("textbox", { name: "What should it remember?" }).fill(text);
    await ask.and(page.locator(":not([disabled])")).waitFor({ timeout: 30_000 });
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/remember", { timeout: 90_000 }),
      ask.click(),
    ]);
    const answered = { status: response.status(), body: await response.json().catch(() => null) };
    const dropped = page.locator("p", { hasText: "dropped:" });
    await dropped.waitFor({ timeout: 90_000 });
    dropTx = /\/tx\/(0x[0-9a-f]{64})/i.exec((await dropped.locator("a").first().getAttribute("href")) ?? "")?.[1];
    result.dropTx = dropTx;
    assert.match(dropTx ?? "", /^0x[0-9a-f]{64}$/i);
    assert.equal(answered.status, 200, `the agent answered ${answered.status}`);
    assert.equal(calls.length, 1, `the page asked the agent once: ${JSON.stringify(calls)}`);
    assert.equal(calls[0].origin, BASE, "the agent was asked with the app's origin");
    step("agent writes (judge step 2)", { agentEndpoint: calls[0].url, pageOrigin: calls[0].origin, ...(await checkDrop(dropTx, answered.body?.envelope)) });
  } else {
    step("the drop, read back (no page step: read-only)", await checkDrop(dropTx));
  }

  await page.goto(`${BASE}/open?to=${address}`, { waitUntil: "domcontentloaded" });
  const letter = page.locator('section[aria-labelledby="inbox-title"] li', { hasText: dropTx.slice(0, 8) });
  await letter.first().waitFor({ timeout: 90_000 });
  step("the inbox lists it", { page: `${BASE}/open?to=${address}`, listed: true });

  assert.deepEqual(problems, [], "no console error, page error or CSP violation");
  result.finishedAt = new Date().toISOString();
  save();
  console.log(`\nwritten ${out}`);
} catch (e) {
  result.failedAt = new Date().toISOString();
  result.error = String(e?.message ?? e).split("\n")[0];
  result.problems = problems;
  save();
  console.error(`FAILED: ${result.error}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
