// End-to-end: the whole Letterlock flow in a real browser against Monad TESTNET, on a local testnet build of the app.
//
//   set -a; source ~/.config/monad/testnet-deployer.env; set +a; node scripts/e2e.mjs [--no-build] [--keep]
//
// Chromium's WebAuthn virtual authenticator (Chrome DevTools Protocol, with PRF) stands in for the passkey, so mera's
// own browser client runs the real ceremonies. The flow: create a passkey and its key → the gas drip funds the passkey
// account → publish → resolve the key on /register → seal a note on /seal → drop it (the account is topped up by the
// testnet deployer, as the drip pays for a first publish only) → the inbox lists it → open with the passkey → the
// seal cracks and the note reads back; then storage is cleared and the passkey finds the address and opens the note
// again. Around it: the drip route's refusals against the real chain, and the error slips the browser can reach
// (PRF_UNSUPPORTED, PASSKEY_FAILED, TAMPERED).
//
// Money: every transaction is on Monad testnet (chain 10143). The app's drip is paid by the TESTNET deployer
// (MONAD_TESTNET_PRIVATE_KEY, passed to the local server's environment only), never by the mainnet drip wallet.
// The key is never printed. Results (addresses and transaction hashes) go to e2e-results/testnet.json.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";
import { createPublicClient, createWalletClient, formatEther, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const here = join(import.meta.dirname, "..");
const next = join(here, "node_modules/.bin/next");
const PORT = Number(process.env.E2E_PORT ?? 3292);
// WebAuthn takes "localhost" as an rpId, never an IP address
const BASE = `http://localhost:${PORT}`;
const DIST = ".next-e2e";
const RPC = "https://testnet-rpc.monad.xyz";
const DIRECTORY = "0x3Da5f339E20AB7325ffBb9df57Fb5656ca1f8b3a";
const CHAIN_ID = 10143;

const KEY = process.env.MONAD_TESTNET_PRIVATE_KEY?.trim();
if (!KEY || !/^0x[0-9a-fA-F]{64}$/.test(KEY)) {
  console.error("MONAD_TESTNET_PRIVATE_KEY is not set: source ~/.config/monad/testnet-deployer.env in the same command");
  process.exit(2);
}
const deployer = privateKeyToAccount(KEY);
const chain = createPublicClient({ chain: monadTestnet, transport: http(RPC) });
const wallet = createWalletClient({ account: deployer, chain: monadTestnet, transport: http(RPC) });

const APP_ENV = {
  NEXT_PUBLIC_LETTERLOCK_CHAIN: "monad-testnet",
  NEXT_PUBLIC_LETTERLOCK_DEV_RPID: "1",
  LETTERLOCK_DIST_DIR: DIST,
  NEXT_TELEMETRY_DISABLED: "1",
};
// the build never sees a key; only the server process gets one, for its drip
const { MONAD_TESTNET_PRIVATE_KEY: _k, LETTERLOCK_DRIP_PRIVATE_KEY: _d, LETTERLOCK_AGENT_PRIVATE_KEY: _a, ...clean } = process.env;

const results = { network: "Monad testnet", chainId: CHAIN_ID, directory: DIRECTORY, app: BASE, startedAt: new Date().toISOString(), steps: {} };
const record = (name, value) => {
  results.steps[name] = value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txOf = (href) => /\/tx\/(0x[0-9a-f]{64})/i.exec(href ?? "")?.[1];

let server;
let browser;

const waitForServer = async () => {
  for (let i = 0; i < 160; i++) {
    try {
      if ((await fetch(BASE, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("the app did not start");
};

/** A browser context with a CTAP2 virtual authenticator: resident keys, user verification, PRF when `prf`. */
const device = async (prf = true) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: prf,
      automaticPresenceSimulation: true,
    },
  });
  const problems = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of 4\d\d/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  await context.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)));
  return { context, page, cdp, authenticatorId, problems };
};

const stored = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), `letterlock:v1:${CHAIN_ID}:localhost`);

const signedDrip = async (account, o = {}) => {
  const address = o.address ?? account.address;
  const chainId = o.chainId ?? CHAIN_ID;
  const minute = o.minute ?? Math.floor(Date.now() / 60_000);
  const signature = await account.signMessage({ message: `letterlock-drip:${address.toLowerCase()}:${chainId}:${minute}` });
  return { address, chainId, minute, signature };
};
const postDrip = async (body) => {
  const r = await fetch(`${BASE}/api/drip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

/** Waits until nothing from the deployer is in flight and its last transaction is 4 blocks old (Monad's reserve rule). */
const deployerQuiet = async () => {
  for (let i = 0; i < 60; i++) {
    const head = await chain.getBlockNumber({ cacheTime: 0 });
    const [now, then, pending] = await Promise.all([
      chain.getTransactionCount({ address: deployer.address }),
      chain.getTransactionCount({ address: deployer.address, blockNumber: head - 4n }),
      chain.getTransactionCount({ address: deployer.address, blockTag: "pending" }),
    ]);
    if (now === then && now === pending) return;
    await sleep(700);
  }
};

before(async () => {
  if (!process.argv.includes("--no-build")) execFileSync(next, ["build"], { cwd: here, env: { ...clean, ...APP_ENV }, stdio: ["ignore", "ignore", "inherit"] });
  server = spawn(next, ["start", "-p", String(PORT), "-H", "localhost"], {
    cwd: here,
    env: { ...clean, ...APP_ENV, DRIP_ENABLED: "true", LETTERLOCK_DRIP_PRIVATE_KEY: KEY, DRIP_DAILY_CAP_MON: "2" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitForServer();
  browser = await chromium.launch();
  record("drip wallet (testnet deployer)", { address: deployer.address, balanceBefore: formatEther(await chain.getBalance({ address: deployer.address })) });
});

after(async () => {
  await browser?.close();
  server?.kill("SIGTERM");
  results.finishedAt = new Date().toISOString();
  mkdirSync(join(here, "e2e-results"), { recursive: true });
  writeFileSync(join(here, "e2e-results/testnet.json"), `${JSON.stringify(results, null, 2)}\n`);
});

describe("Letterlock on Monad testnet, in a browser, with a virtual passkey", { concurrency: false }, () => {
  let A; // the device that makes the address
  let address;
  let note;
  let envelopeJson;

  it("creates a passkey and its key, gets the drip, and publishes epoch 1", { timeout: 180_000 }, async () => {
    A = await device();
    const { page } = A;
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByText("Testnet build.").waitFor();
    const create = page.getByRole("button", { name: "Create my encryption address" });
    await create.and(page.locator(":not([disabled])")).waitFor({ timeout: 20_000 });
    await create.click();
    const docket = page.locator('ol[aria-label="Creating your encryption address"] > li');
    await docket.nth(3).and(page.locator('[data-status="done"]')).waitFor({ timeout: 150_000 });
    const s = await stored(page);
    assert.match(s?.address ?? "", /^0x[0-9a-fA-F]{40}$/, "the device stores the passkey account's address");
    // only the passkey's public metadata and the address: nothing secret
    for (const k of Object.keys(s)) assert.ok(["v", "chainId", "rpId", "credentialId", "transports", "address"].includes(k), `stored ${k}`);
    address = s.address;
    const dripTx = txOf(await docket.nth(2).locator("a").first().getAttribute("href"));
    const publishTx = txOf(await docket.nth(3).locator("a").first().getAttribute("href"));
    assert.ok(dripTx && publishTx, "the drip and the publish are linked");
    // independently of the page: the chain says the same
    const [publish, publishSent, drip, key] = await Promise.all([
      chain.getTransactionReceipt({ hash: publishTx }),
      chain.getTransaction({ hash: publishTx }),
      chain.getTransaction({ hash: dripTx }),
      chain.readContract({
        address: DIRECTORY,
        abi: [{ type: "function", name: "keyOf", stateMutability: "view", inputs: [{ name: "who", type: "address" }], outputs: [{ name: "pub", type: "bytes32" }, { name: "epoch", type: "uint32" }, { name: "updatedAt", type: "uint64" }] }],
        functionName: "keyOf",
        args: [address],
      }),
    ]);
    assert.equal(publish.status, "success");
    assert.equal(publish.from.toLowerCase(), address.toLowerCase(), "msg.sender of the publish is the passkey account");
    assert.equal(drip.from.toLowerCase(), deployer.address.toLowerCase(), "the drip came from the testnet deployer");
    assert.equal(drip.to.toLowerCase(), address.toLowerCase());
    assert.equal(key[1], 1, "keyOf returns epoch 1");
    // Monad mainnet's RPC takes a transaction only when its sender holds gas limit x fee cap; testnet's does not check,
    // so the drip's size is checked here against the publish the wallet actually signed
    assert.ok(drip.value >= publishSent.gas * publishSent.maxFeePerGas, `the drip (${formatEther(drip.value)}) covers the publish's gas x fee cap (${formatEther(publishSent.gas * publishSent.maxFeePerGas)})`);
    // the card prints the key keyOf returns
    const card = page.locator("article").filter({ hasText: "Your encryption address" });
    await card.getByText("Rotating posts epoch 2").waitFor({ timeout: 20_000 });
    assert.ok((await card.innerText()).toLowerCase().includes(address.toLowerCase().slice(2, 12)), "the card shows the address");
    record("create + drip + publish", {
      address,
      dripTx,
      dripAmount: formatEther(drip.value),
      publishTx,
      publishBlock: Number(publish.blockNumber),
      publishGas: Number(publish.gasUsed),
      publishFeeCapGwei: Number(publishSent.maxFeePerGas) / 1e9,
      publishNeeded: formatEther(publishSent.gas * publishSent.maxFeePerGas),
      publicKey: key[0],
    });
    assert.deepEqual(A.problems, []);
  });

  it("resolves the new key live on /register", { timeout: 60_000 }, async () => {
    const { page } = A;
    await page.goto(`${BASE}/register`, { waitUntil: "domcontentloaded" });
    await page.getByRole("textbox", { name: "Look up" }).fill(address);
    await page.getByRole("button", { name: "Look up" }).click();
    await page.getByText("Found by keyOf").first().waitFor({ timeout: 30_000 });
    const text = await page.locator('[aria-live="polite"]').first().innerText();
    assert.match(text, /\b1\b/);
    record("resolve on /register", { found: true });
  });

  it("seals a note to it on /seal, with the wax pressed", { timeout: 60_000 }, async () => {
    const { page } = A;
    note = `Letterlock e2e ${new Date().toISOString()}: the dentist moved to Thursday at 10:40.`;
    await page.goto(`${BASE}/seal?to=${address}`, { waitUntil: "domcontentloaded" });
    await page.getByText("Found by keyOf").first().waitFor({ timeout: 30_000 });
    await page.getByRole("textbox", { name: "Note" }).fill(note);
    await page.getByRole("button", { name: "Seal", exact: true }).click();
    await page.getByText("Sealed to key").waitFor({ timeout: 20_000 });
    await page.locator('section[aria-labelledby="sealed-title"] svg[data-state="pressed"]').waitFor();
    envelopeJson = (await page.locator("details pre").textContent()) ?? "";
    const env = JSON.parse(envelopeJson);
    assert.equal(env.chainId, CHAIN_ID);
    assert.equal(env.recipient, address.toLowerCase());
    assert.equal(env.epoch, 1);
    assert.ok(!envelopeJson.includes("dentist"), "the envelope does not carry the note in the clear");
    record("seal", { kid: env.kid, epoch: env.epoch, bytes: Buffer.byteLength(JSON.stringify(env)) });
  });

  it("drops the envelope from the passkey account (topped up by the testnet deployer)", { timeout: 120_000 }, async () => {
    const { page } = A;
    // the drip pays for one publish only: a drop is paid from the account's own MON
    await deployerQuiet();
    const topUp = await wallet.sendTransaction({ to: address, value: parseEther("0.02") });
    await chain.waitForTransactionReceipt({ hash: topUp });
    await sleep(2_000); // three blocks, so consensus sees the balance
    await page.getByRole("button", { name: "Post to their inbox" }).click();
    await page.getByText("Posted to the inbox of").waitFor({ timeout: 90_000 });
    const dropTx = txOf(await page.locator("p", { hasText: "Posted to the inbox of" }).locator("a").first().getAttribute("href"));
    const receipt = await chain.getTransactionReceipt({ hash: dropTx });
    assert.equal(receipt.status, "success");
    assert.equal(receipt.from.toLowerCase(), address.toLowerCase());
    record("drop", { topUpTx: topUp, dropTx, dropBlock: Number(receipt.blockNumber), dropGas: Number(receipt.gasUsed) });
  });

  it("lists it in the inbox and opens it with the passkey: the seal cracks and the note reads back", { timeout: 120_000 }, async () => {
    const { page } = A;
    await page.goto(`${BASE}/open`, { waitUntil: "domcontentloaded" });
    const reader = page.locator('section[aria-labelledby="reader-title"]');
    await reader.getByRole("button", { name: "Open with passkey" }).waitFor({ timeout: 90_000 });
    await reader.getByRole("button", { name: "Open with passkey" }).click();
    await reader.locator('svg[data-state="cracked"]').waitFor({ timeout: 30_000 });
    await reader.getByText(note).waitFor({ timeout: 10_000 });
    record("inbox + open", { opened: true, text: "matches the sealed note" });
    assert.deepEqual(A.problems, []);
  });

  it("with this browser's storage cleared, the passkey finds the address and opens the note again", { timeout: 120_000 }, async () => {
    const { page } = A;
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/open`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Find my inbox with my passkey" }).click();
    const reader = page.locator('section[aria-labelledby="reader-title"]');
    await reader.getByRole("button", { name: "Open with passkey" }).waitFor({ timeout: 90_000 });
    assert.equal((await stored(page))?.address?.toLowerCase(), address.toLowerCase(), "the passkey derived the same address");
    await reader.getByRole("button", { name: "Open with passkey" }).click();
    await reader.getByText(note).waitFor({ timeout: 30_000 });
    record("storage cleared + reopen", { sameAddress: true, opened: true });
  });

  it("rotates to epoch 2 from the account's own MON; the epoch-1 note still opens, and new notes seal to epoch 2", { timeout: 180_000 }, async () => {
    const { page } = A;
    await page.goto(BASE, { waitUntil: "networkidle" });
    const card = page.locator("article").filter({ hasText: "Your encryption address" });
    await card.getByText("Rotating posts epoch 2").waitFor({ timeout: 30_000 });
    await card.getByRole("button", { name: "Rotate key" }).click();
    const docket = page.locator('ol[aria-label="Rotating your key"] > li');
    await docket.nth(2).and(page.locator('[data-status="done"]')).waitFor({ timeout: 120_000 });
    const rotateTx = txOf(await docket.nth(2).locator("a").first().getAttribute("href"));
    const receipt = await chain.getTransactionReceipt({ hash: rotateTx });
    assert.equal(receipt.status, "success");
    await card.getByText("Rotating posts epoch 3").waitFor({ timeout: 30_000 });
    // the note sealed to epoch 1 still opens: the passkey re-derives every earlier key
    await page.goto(`${BASE}/open`, { waitUntil: "domcontentloaded" });
    const reader = page.locator('section[aria-labelledby="reader-title"]');
    await reader.getByRole("button", { name: "Open with passkey" }).waitFor({ timeout: 90_000 });
    await reader.getByRole("button", { name: "Open with passkey" }).click();
    await reader.getByText(note).waitFor({ timeout: 30_000 });
    // and a new note seals to epoch 2
    await page.goto(`${BASE}/seal?to=${address}`, { waitUntil: "domcontentloaded" });
    await page.getByText("Found by keyOf").first().waitFor({ timeout: 30_000 });
    await page.getByRole("textbox", { name: "Note" }).fill("after the rotation");
    await page.getByRole("button", { name: "Seal", exact: true }).click();
    await page.getByText("Sealed to key").waitFor({ timeout: 20_000 });
    assert.equal(JSON.parse((await page.locator("details pre").textContent()) ?? "{}").epoch, 2);
    record("rotate", { rotateTx, rotateBlock: Number(receipt.blockNumber), epochOneStillOpens: true, newSealEpoch: 2 });
    assert.deepEqual(A.problems, []);
  });

  it("a tampered envelope, pasted, is refused as TAMPERED after the passkey prompt", { timeout: 60_000 }, async () => {
    const { page } = A;
    const env = JSON.parse(envelopeJson);
    const ct = env.ct;
    // flip one character of the ciphertext to another base64url digit
    const i = Math.floor(ct.length / 2);
    env.ct = `${ct.slice(0, i)}${ct[i] === "A" ? "B" : "A"}${ct.slice(i + 1)}`;
    await page.goto(`${BASE}/open`, { waitUntil: "domcontentloaded" });
    await page.getByText("Paste an envelope").click();
    await page.getByLabel("Envelope JSON").fill(JSON.stringify(env));
    await page.locator("form[aria-label='Open a pasted envelope']").getByRole("button", { name: "Open with passkey" }).click();
    await page.locator('[data-code="TAMPERED"]').waitFor({ timeout: 30_000 });
    record("tampered", { slip: "TAMPERED" });
  });

  it("a device with no passkey for the site gets the PASSKEY_FAILED slip", { timeout: 60_000 }, async () => {
    const B = await device();
    await B.page.goto(`${BASE}/open`, { waitUntil: "domcontentloaded" });
    await B.page.getByText("Paste an envelope").click();
    await B.page.getByLabel("Envelope JSON").fill(envelopeJson);
    await B.page.locator("form[aria-label='Open a pasted envelope']").getByRole("button", { name: "Open with passkey" }).click();
    await B.page.locator('[data-code="PASSKEY_FAILED"]').waitFor({ timeout: 30_000 });
    await B.context.close();
    record("no passkey", { slip: "PASSKEY_FAILED" });
  });

  it("an authenticator without PRF gets the PRF_UNSUPPORTED slip, and nothing is posted", { timeout: 60_000 }, async () => {
    const C = await device(false);
    await C.page.goto(BASE, { waitUntil: "networkidle" });
    const create = C.page.getByRole("button", { name: "Create my encryption address" });
    await create.and(C.page.locator(":not([disabled])")).waitFor({ timeout: 20_000 });
    await create.click();
    await C.page.locator('[data-code="PRF_UNSUPPORTED"]').waitFor({ timeout: 30_000 });
    await C.context.close();
    record("no PRF", { slip: "PRF_UNSUPPORTED" });
  });
});

describe("the gas drip's refusals, against the chain", { concurrency: false }, () => {
  it("refuses a signature by anyone but the account, an old signature, and another chain", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const stranger = privateKeyToAccount(generatePrivateKey());
    const forged = await signedDrip(stranger, { address: account.address });
    assert.deepEqual([(await postDrip(forged)).status, (await postDrip(forged)).body.error], [401, "BAD_SIGNATURE"]);
    const old = await signedDrip(account, { minute: Math.floor(Date.now() / 60_000) - 6 });
    assert.equal((await postDrip(old)).body.error, "STALE_SIGNATURE");
    const mainnet = await signedDrip(account, { chainId: 143 });
    assert.equal((await postDrip(mainnet)).body.error, "WRONG_CHAIN");
    assert.equal((await postDrip({ ...(await signedDrip(account)), extra: true })).body.error, "BAD_REQUEST");
  });

  it("refuses an account that already has a key (the deployer's smoke-test key)", async () => {
    const r = await postDrip(await signedDrip(deployer));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "HAS_KEY");
  });

  it("funds a new, empty account once; the same account asking again is refused", { timeout: 90_000 }, async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    await deployerQuiet();
    let first;
    for (let i = 0; i < 6; i++) {
      first = await postDrip(await signedDrip(account));
      if (first.body.error !== "DRIP_BUSY") break;
      await sleep(1_500);
    }
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.dripped, true);
    const balance = await chain.getBalance({ address: account.address });
    assert.ok(balance > 0n && balance <= parseEther("0.02"), `the drip sent ${formatEther(balance)} MON, at most 0.02`);
    const again = await postDrip(await signedDrip(account));
    assert.equal(again.status, 409);
    assert.ok(["ALREADY_DRIPPED", "ALREADY_FUNDED"].includes(again.body.error), again.body.error);
    record("drip API", { fundedAccount: account.address, dripTx: first.body.transactionHash, amount: first.body.amount, secondRequest: again.body.error });
  });
});
