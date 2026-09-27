// ONE real run of the live site on Monad MAINNET, with a virtual passkey. It spends real MON from the gas drip (one
// drip, about 0.0168 MON with its fee) and from the reference agent's wallet (one drop), so it refuses to run twice:
// its record, e2e-results/mainnet-live.json, is the proof, and a second run needs --again.
//
//   node scripts/live-mainnet.mjs --spend-the-drip-once [--again]
//
// On https://<LETTERLOCK_RP_ID> (the production rpId, app.letterlock.edycu.dev since SDK 0.1.1), Chromium's WebAuthn
// virtual authenticator (with PRF) stands in for the passkey: create -> the drip -> publish; the new line on /register;
// seal a note and open it pasted; ask the reference agent to write (POST /remember, from the page, to the agent URL
// this build names) and open its envelope from the inbox; clear the storage and let the passkey find the address
// again. Every chain fact is read back from rpc.monad.xyz. The record names the site, its rpId and the agent endpoint
// the page called: the runs before SDK 0.1.1 were at letterlock-app.vercel.app, the rpId 0.1.0 pinned.
// The virtual authenticator is deleted when the run ends, so the key it published can never be opened again: the run
// adds it to lib/known-keys.json, and the register marks its line.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LETTERLOCK_RP_ID, VERSION } from "letterlock";
import { chromium } from "playwright";
import { createPublicClient, formatEther, http } from "viem";
import { monad } from "viem/chains";

const here = join(import.meta.dirname, "..");
const BASE = `https://${LETTERLOCK_RP_ID}`;
const STORED = `letterlock:v1:143:${LETTERLOCK_RP_ID}`;
const RPC = "https://rpc.monad.xyz";
const record = JSON.parse(readFileSync(join(here, "../../deployments/143.json"), "utf8"));
const DIRECTORY = record.address;
const DRIP = "0x679f4d96bB36fE383110E3Ef6F46daAf92fb315b";
const out = join(here, "e2e-results/mainnet-live.json");

if (!process.argv.includes("--spend-the-drip-once")) {
  console.error("this run spends real MON on Monad mainnet: pass --spend-the-drip-once");
  process.exit(2);
}
const previous = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { about: "Live runs of the production app on Monad mainnet with a virtual passkey (scripts/live-mainnet.mjs), each on the site it names. Each run spends one drip.", runs: [] };
if (previous.runs.length > 0 && !process.argv.includes("--again")) {
  console.error(`${out} records ${previous.runs.length} live run(s): each spends a drip. Pass --again only on purpose.`);
  process.exit(2);
}
const save = () => writeFileSync(out, `${JSON.stringify({ ...previous, runs: [...previous.runs, result] }, null, 2)}\n`);

const chain = createPublicClient({ chain: monad, transport: http(RPC) });
const keyOfAbi = [
  { type: "function", name: "keyOf", stateMutability: "view", inputs: [{ name: "who", type: "address" }], outputs: [{ name: "pub", type: "bytes32" }, { name: "epoch", type: "uint32" }, { name: "updatedAt", type: "uint64" }] },
];
const txOf = (href) => /\/tx\/(0x[0-9a-f]{64})/i.exec(href ?? "")?.[1];
/**
 * Waits until React has hydrated the element `selector` names. Before that a click on a form's button submits it
 * natively (the register's lookup reloads as /register?q=…, which the page does not read) or does nothing: the
 * run of 2026-09-27, 21:22 UTC lost its register step to that race.
 */
const hydrated = (page, selector) =>
  page.waitForFunction((s) => {
    const el = document.querySelector(s);
    return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
  }, selector, { timeout: 30_000 });
const result = { site: BASE, rpId: LETTERLOCK_RP_ID, sdk: VERSION, network: record.network, chainId: record.chainId, directory: DIRECTORY, startedAt: new Date().toISOString(), steps: {} };
const step = (name, value) => {
  result.steps[name] = value;
  console.log(`ok   ${name}: ${JSON.stringify(value)}`);
};

const browser = await chromium.launch();
const problems = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const agentCalls = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/remember") agentCalls.push(r.url());
  });
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  await context.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  const dripBefore = await chain.getBalance({ address: DRIP });

  // 1. create, drip, publish
  await page.goto(BASE, { waitUntil: "networkidle" });
  const create = page.getByRole("button", { name: "Create my encryption address" });
  await create.and(page.locator(":not([disabled])")).waitFor({ timeout: 30_000 });
  const t0 = Date.now();
  await create.click();
  const docket = page.locator('ol[aria-label="Creating your encryption address"] > li');
  await docket.nth(3).and(page.locator('[data-status="done"]')).waitFor({ timeout: 180_000 });
  const seconds = (Date.now() - t0) / 1000;
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), STORED);
  const address = stored?.address;
  assert.match(address ?? "", /^0x[0-9a-fA-F]{40}$/);
  const dripTx = txOf(await docket.nth(2).locator("a").first().getAttribute("href"));
  const publishTx = txOf(await docket.nth(3).locator("a").first().getAttribute("href"));
  const [drip, dripReceipt, publish, publishSent, key] = await Promise.all([
    chain.getTransaction({ hash: dripTx }),
    chain.getTransactionReceipt({ hash: dripTx }),
    chain.getTransactionReceipt({ hash: publishTx }),
    chain.getTransaction({ hash: publishTx }),
    chain.readContract({ address: DIRECTORY, abi: keyOfAbi, functionName: "keyOf", args: [address] }),
  ]);
  assert.equal(drip.from.toLowerCase(), DRIP.toLowerCase(), "the drip came from the drip wallet");
  assert.equal(drip.to.toLowerCase(), address.toLowerCase());
  assert.equal(dripReceipt.status, "success");
  assert.equal(publish.status, "success");
  assert.equal(publish.from.toLowerCase(), address.toLowerCase(), "msg.sender of the publish is the passkey account");
  // Monad mainnet's RPC takes a transaction only when its sender holds gas limit x the fee cap it was signed with
  assert.ok(drip.value >= publishSent.gas * publishSent.maxFeePerGas, `the drip (${formatEther(drip.value)}) covers the publish's gas x fee cap (${formatEther(publishSent.gas * publishSent.maxFeePerGas)})`);
  assert.equal(key[1], 1);
  const dripAfter = await chain.getBalance({ address: DRIP });
  step("create + drip + publish", {
    address,
    seconds,
    dripTx,
    dripAmount: formatEther(drip.value),
    dripWalletSpent: formatEther(dripBefore - dripAfter),
    dripBlock: Number(dripReceipt.blockNumber),
    publishTx,
    publishBlock: Number(publish.blockNumber),
    publishGas: Number(publish.gasUsed),
    publishFeeCapGwei: Number(publishSent.maxFeePerGas) / 1e9,
    publishNeeded: formatEther(publishSent.gas * publishSent.maxFeePerGas),
    publicKey: key[0],
    epoch: key[1],
  });

  // 2. the register finds it live
  await page.goto(`${BASE}/register`, { waitUntil: "domcontentloaded" });
  await hydrated(page, 'form[aria-label="Look up an address"]');
  await page.getByRole("textbox", { name: "Look up" }).fill(address);
  await page.getByRole("button", { name: "Look up" }).click();
  await page.getByText("Found by keyOf").first().waitFor({ timeout: 30_000 });
  await page.waitForFunction((a) => document.querySelector("section[aria-labelledby=live-title]")?.textContent?.toLowerCase().includes(a.slice(2, 8)), address.toLowerCase(), { timeout: 60_000 });
  step("register", { lookup: "found", line: "listed" });

  // 3. seal to it (no transaction) and open it pasted, with the passkey, under the production rpId
  const note = `Letterlock live check ${new Date().toISOString()}: sealed on the live site to a key made by a virtual passkey.`;
  await page.goto(`${BASE}/seal?to=${address}`, { waitUntil: "domcontentloaded" });
  await page.getByText("Found by keyOf").first().waitFor({ timeout: 30_000 });
  await page.getByRole("textbox", { name: "Note" }).fill(note);
  await page.getByRole("button", { name: "Seal", exact: true }).click();
  await page.getByText("Sealed to key").waitFor({ timeout: 20_000 });
  const envelope = (await page.locator("details pre").textContent()) ?? "";
  assert.equal(JSON.parse(envelope).chainId, 143);
  await page.goto(`${BASE}/open`, { waitUntil: "domcontentloaded" });
  await hydrated(page, "form[aria-label='Open a pasted envelope']");
  await page.getByText("Paste an envelope").click();
  await page.getByLabel("Envelope JSON").fill(envelope);
  await page.locator("form[aria-label='Open a pasted envelope']").getByRole("button", { name: "Open with passkey" }).click();
  await page.locator('section[aria-labelledby="reader-title"]').getByText(note).waitFor({ timeout: 30_000 });
  step("seal + open pasted", { kid: JSON.parse(envelope).kid, bytes: Buffer.byteLength(envelope), opened: true });

  // 4. the judge's route: the reference agent writes to the new address (its own wallet pays), the inbox opens it
  await page.goto(`${BASE}/judge`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Ask the agent" }).and(page.locator(":not([disabled])")).waitFor({ timeout: 30_000 });
  const agentText = `Remember for me (live check ${new Date().toISOString()}): the dentist moved to Thursday at 10:40.`;
  await page.getByRole("textbox", { name: "What should it remember?" }).fill(agentText);
  await page.getByRole("button", { name: "Ask the agent" }).click();
  const dropped = page.locator("p", { hasText: "dropped:" });
  await dropped.waitFor({ timeout: 90_000 });
  const agentTx = txOf(await dropped.locator("a").first().getAttribute("href"));
  const agentReceipt = await chain.getTransactionReceipt({ hash: agentTx });
  assert.equal(agentReceipt.status, "success");
  await page.goto(`${BASE}/open`, { waitUntil: "domcontentloaded" });
  const reader = page.locator('section[aria-labelledby="reader-title"]');
  await reader.getByRole("button", { name: "Open with passkey" }).waitFor({ timeout: 90_000 });
  await reader.getByRole("button", { name: "Open with passkey" }).click();
  await reader.getByText(agentText).waitFor({ timeout: 30_000 });
  assert.equal(agentCalls.length, 1, `the page asked the agent once: ${agentCalls.join(", ")}`);
  step("agent writes, inbox opens", { agentEndpoint: agentCalls[0], agentDropTx: agentTx, agentDropBlock: Number(agentReceipt.blockNumber), agentWallet: agentReceipt.from, opened: true });

  // 5. storage cleared: the passkey finds the address again and opens the agent's letter
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/open`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Find my inbox with my passkey" }).waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.includes("Find my inbox with my passkey"));
    return !!b && Object.keys(b).some((k) => k.startsWith("__reactProps$"));
  }, null, { timeout: 30_000 });
  await page.getByRole("button", { name: "Find my inbox with my passkey" }).click();
  await reader.getByRole("button", { name: "Open with passkey" }).waitFor({ timeout: 90_000 });
  const again = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), STORED);
  assert.equal(again?.address?.toLowerCase(), address.toLowerCase());
  await reader.getByRole("button", { name: "Open with passkey" }).click();
  await reader.getByText(agentText).waitFor({ timeout: 30_000 });
  step("storage cleared + reopen", { sameAddress: true, opened: true });

  assert.deepEqual(problems, [], "no console error, page error or CSP violation");
  result.finishedAt = new Date().toISOString();
  save();

  // the key's passkey dies with this browser: mark its line in the register
  const knownPath = join(here, "lib/known-keys.json");
  const known = JSON.parse(readFileSync(knownPath, "utf8"));
  if (!known.keys.some((k) => k.txHash === publishTx))
    known.keys.push({
      chainId: 143,
      address,
      txHash: publishTx,
      note: "Test key from the app’s live check: a browser’s virtual passkey, deleted after the run. Nothing sealed to it can be opened",
    });
  writeFileSync(knownPath, `${JSON.stringify(known, null, 2)}\n`);
  console.log(`\nwritten ${out}`);
} catch (e) {
  result.failedAt = new Date().toISOString();
  result.error = String(e?.message ?? e).split("\n")[0];
  result.problems = problems;
  // what the page said: the flow's docket and any slip or notice
  try {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) {
      result.page = {
        url: page.url(),
        docket: (await page.locator("ol[aria-label]").allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ")),
        alerts: (await page.locator("[role=alert]").allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ")),
      };
      await page.screenshot({ path: join(here, "qa/live-mainnet-failure.png"), fullPage: true }).catch(() => {});
    }
  } catch {}
  save();
  console.error(`FAILED: ${result.error}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
