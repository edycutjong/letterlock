// The drip route's checks before any chain read (lib/drip-server.ts, admitDrip), with the limits it keeps in each
// server instance's memory. The judges' pass is read before the IP is counted, because the per-IP drips limit binds the
// public only: judges who share one network (a venue's Wi-Fi, an office's NAT, one VPN exit) each get their drip. A
// throwaway key stands in for the drip wallet's; nothing here reads a chain or sends anything.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// lib/chain.ts reaches the deployment records: a .json file loads as the module Next.js makes of it
registerHooks({
  load: (url, context, nextLoad) =>
    url.startsWith("file:") && url.endsWith(".json")
      ? { format: "module", source: `export default ${readFileSync(new URL(url), "utf8")};`, shortCircuit: true }
      : nextLoad(url, context),
});

const PASS = "Jd7mQ2xLp9Rt4Vw8Zb3Nc6";
process.env.DRIP_ENABLED = "true";
process.env.LETTERLOCK_DRIP_PRIVATE_KEY = generatePrivateKey();
process.env.DRIP_JUDGE_PASS = PASS;
const { IP_DRIPS, IP_REQUESTS, admitDrip, recordDrip } = await import("../lib/drip-server.ts");
const { dripMessage, unixMinute } = await import("../lib/drip.ts");
const { DEPLOYMENT } = await import("../lib/chain.ts");

/** A signed request from a new account, with the judges' pass when given. */
const request = async (pass?: string) => {
  const a = privateKeyToAccount(generatePrivateKey());
  const minute = unixMinute(Date.now());
  const signature = await a.signMessage({ message: dripMessage(a.address, DEPLOYMENT.chainId, minute) });
  return { address: a.address, chainId: DEPLOYMENT.chainId, minute, signature, ...(pass === undefined ? {} : { pass }) };
};
const newAddress = () => privateKeyToAccount(generatePrivateKey()).address;

test("judges who share a network each get past its drips limit; the public from it stops at 3 drips a day", async () => {
  const ip = "203.0.113.7"; // a venue's Wi-Fi: three drips already paid to it on this instance
  for (let i = 0; i < IP_DRIPS.max; i++) recordDrip(newAddress(), ip);
  const pub = await admitDrip(await request(), ip);
  assert.deepEqual([pub.lane, pub.refusal?.code], ["public", "RATE_LIMITED"]);
  for (let judge = 0; judge < 3; judge++) {
    const j = await admitDrip(await request(PASS), ip);
    assert.deepEqual([j.lane, j.reserve, j.refusal], ["judge", true, undefined], `judge ${judge + 4} on this network`);
    recordDrip(j.pre.request.address, ip);
  }
  // a wrong pass is the public's lane, and is held to the network's limit
  const wrong = await admitDrip(await request(`${PASS.slice(0, -1)}x`), ip);
  assert.deepEqual([wrong.lane, wrong.refusal?.code], ["public", "RATE_LIMITED"]);
});

test(`every lane is still held to ${IP_REQUESTS.max} requests per network in 10 minutes`, async () => {
  const ip = "198.51.100.9";
  for (let i = 0; i < IP_REQUESTS.max; i++) assert.equal((await admitDrip(await request(PASS), ip)).refusal, undefined, `request ${i + 1}`);
  assert.equal((await admitDrip(await request(PASS), ip)).refusal?.code, "RATE_LIMITED");
});

test("the checks before the IP's keep their order: a stale or forged signature, and an address this instance funded, are refused in any lane", async () => {
  const ip = "192.0.2.44";
  const r = await request(PASS);
  assert.equal((await admitDrip({ ...r, minute: r.minute - 60 }, ip)).refusal?.code, "STALE_SIGNATURE");
  assert.equal((await admitDrip({ ...r, address: newAddress() }, ip)).refusal?.code, "BAD_SIGNATURE");
  recordDrip(r.address, "192.0.2.45");
  assert.equal((await admitDrip(r, ip)).refusal?.code, "ALREADY_DRIPPED");
});

test("the route admits through admitDrip: the lane is known before the IP is counted", () => {
  const route = readFileSync(new URL("../app/api/drip/route.ts", import.meta.url), "utf8");
  assert.match(route, /await admitDrip\(request, ip\)/);
  assert.doesNotMatch(route, /allowIp\(/, "the route does not count the IP itself");
});
