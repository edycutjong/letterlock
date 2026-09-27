// The page's side of the gas drip (lib/gas.ts, requestDrip): what it sends, and how it reads each answer. Vercel's
// firewall answers its per-IP limit itself, with a body the drip never writes; a drip sent but not yet confirmed is a
// 202; the judges' pass goes with the request when this tab was opened with the judges' link. The requests go to a
// stand-in for fetch, and the account is a real viem account, so the signature is real.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// lib/gas.ts reaches the deployment records through lib/chain.ts: a .json file loads as the module Next.js makes of it
registerHooks({
  load: (url, context, nextLoad) =>
    url.startsWith("file:") && url.endsWith(".json")
      ? { format: "module", source: `export default ${readFileSync(new URL(url), "utf8")};`, shortCircuit: true }
      : nextLoad(url, context),
});
const { requestDrip } = await import("../lib/gas.ts");
const { DripRefused, toFailure } = await import("../lib/failure.ts");
const { dripMessage } = await import("../lib/drip.ts");

const account = privateKeyToAccount(generatePrivateKey());
const realFetch = globalThis.fetch;
const g = globalThis as { window?: unknown };
afterEach(() => {
  globalThis.fetch = realFetch;
  delete g.window;
});

/** Stands in for fetch: records each request body and answers with `answers` in turn. */
const answering = (...answers: { status: number; body: unknown }[]) => {
  const sent: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as Record<string, unknown>);
    const a = answers[Math.min(sent.length - 1, answers.length - 1)]!;
    return new Response(typeof a.body === "string" ? a.body : JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return sent;
};

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof DripRefused, String(e));
    return e;
  }
  return assert.fail("expected the drip to refuse");
};

test("the firewall's own 429 is RATE_LIMITED with words a person can act on, not the object it answered", async () => {
  const sent = answering({ status: 429, body: { error: { code: "429", message: "Too Many Requests" } } });
  const e = await refusal(requestDrip(account));
  assert.equal(e.code, "RATE_LIMITED");
  assert.match(e.message, /too many drip requests from this network/);
  assert.equal(sent.length, 1, "a rate limit is not asked again at once");
  const f = toFailure(e);
  assert.equal(f.kind, "slip");
  assert.doesNotMatch(JSON.stringify(f), /object Object/);
});

test("the drip's own refusals keep their code and message", async () => {
  answering({ status: 429, body: { error: "HOURLY_CAP", message: "the drip has paid out its limit for this hour; try again in an hour" } });
  const e = await refusal(requestDrip(account));
  assert.deepEqual([e.code, e.message], ["HOURLY_CAP", "the drip has paid out its limit for this hour; try again in an hour"]);
  answering({ status: 502, body: "<html>bad gateway</html>" });
  const g502 = await refusal(requestDrip(account));
  assert.deepEqual([g502.code, g502.message], ["HTTP_502", "the drip answered HTTP 502"]);
});

test("a drip sent but not confirmed yet (202) is a drip: the page goes on to wait for its MON", async () => {
  const hash = `0x${"cd".repeat(32)}`;
  answering({ status: 202, body: { dripped: true, pending: true, transactionHash: hash, amount: "0.01421795232", explorer: `https://monadvision.com/tx/${hash}` } });
  assert.deepEqual(await requestDrip(account), { transactionHash: hash, amount: "0.01421795232", explorer: `https://monadvision.com/tx/${hash}` });
});

test("the request is signed by the account, and carries the judges' pass only when this tab has one", async () => {
  const ok = { status: 200, body: { dripped: false, reason: "FUNDED" } };
  let sent = answering(ok);
  assert.equal(await requestDrip(account), undefined);
  assert.equal("pass" in sent[0]!, false, "no pass in a tab opened without the judges' link");
  const body = sent[0] as { address: `0x${string}`; chainId: number; minute: number; signature: `0x${string}` };
  assert.equal(await verifyMessage({ address: account.address, message: dripMessage(body.address, body.chainId, body.minute), signature: body.signature }), true);

  const pass = "Jd7mQ2xLp9Rt4Vw8Zb3Nc6";
  g.window = { sessionStorage: { getItem: (k: string) => (k === "letterlock:judge-pass" ? pass : null) } };
  sent = answering(ok);
  await requestDrip(account);
  assert.equal(sent[0]!.pass, pass);

  // anything stored that is not a pass is not sent
  g.window = { sessionStorage: { getItem: () => "short" } };
  sent = answering(ok);
  await requestDrip(account);
  assert.equal("pass" in sent[0]!, false);
});
