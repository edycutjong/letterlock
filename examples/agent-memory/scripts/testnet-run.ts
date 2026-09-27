#!/usr/bin/env node
// The integration run on Monad TESTNET: the built Vercel function (the file production runs) served on node:http,
// against the testnet directory, paying gas from a funded testnet wallet. It sends real testnet drops and reads each
// one back from the chain; nothing touches mainnet.
//
//   AGENT_WALLET_KEY=0x…  node scripts/testnet-run.ts --open-with FILE
//
// AGENT_WALLET_KEY  a funded Monad testnet key (it pays for the drops, and nothing else).
// --open-with FILE  the stand-in of a TEST KEY published on the testnet directory (contracts/script/smoke.mjs key
//                   file, kept outside the repository): the run seals to that address and opens what it gets.
//
// The testnet directory has no ERC-8004 registry, so no agent key can be published there: the run gives the agent a
// fresh random seed and seals its task to the key /health reports (the mainnet path, keyOfAgent, is test/chain.test.ts
// on anvil and the mainnet round trip in README.md).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fromHex, seal } from "letterlock";
import { createPublicClient, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeTask, newNonce } from "../src/task.ts";
import { post, remember, session, task } from "./call.ts";
import { serve } from "./serve.ts";

const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const openWith = args[args.indexOf("--open-with") + 1];
if (!args.includes("--open-with") || !openWith) throw new Error("--open-with FILE is required (a testnet TEST KEY stand-in)");
const walletKey = process.env.AGENT_WALLET_KEY;
if (!walletKey) throw new Error("AGENT_WALLET_KEY must hold a funded Monad testnet key");
const recipient = (JSON.parse(readFileSync(openWith, "utf8")) as { recipient: string }).recipient;
const wallet = privateKeyToAccount(walletKey as `0x${string}`).address;
const rpc = createPublicClient({ transport: http("https://testnet-rpc.monad.xyz") });

execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "inherit" });
const bundle = pathToFileURL(join(root, ".vercel", "output", "functions", "api", "agent.func", "index.mjs")).href;

// The function reads its environment when it loads, as on Vercel.
Object.assign(process.env, {
  AGENT_ENABLED: "true",
  LETTERLOCK_CHAIN: "monad-testnet",
  LETTERLOCK_AGENT_PRIVATE_KEY: walletKey,
  LETTERLOCK_AGENT_KEY_SEED: randomBytes(32).toString("hex"),
  LETTERLOCK_AGENT_KEY_FIRST_EPOCH: "2",
});
const handler = (await import(bundle)) as { default: Parameters<typeof serve>[0] };
const server = await serve(handler.default, 0);
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

const checks: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail: unknown) => {
  checks[name] = { ok, ...(typeof detail === "object" && detail !== null ? detail : { detail }) };
  if (!ok) process.exitCode = 1;
};

try {
  const balanceBefore = await rpc.getBalance({ address: wallet });
  const nonceBefore = await rpc.getTransactionCount({ address: wallet });
  const s = await session(base);
  check("health", s.health.chain.chainId === 10143 && s.health.key.held.epoch === 2 && s.health.enabled === true, {
    chainId: s.health.chain.chainId,
    directory: s.health.chain.directory,
    wallet: s.health.wallet.address,
    balance: s.health.wallet.balance,
    keyHeld: s.health.key.held,
    keyPublished: s.health.key.published,
    dailyDrops: s.health.limits.dailyDrops,
  });

  const stamp = new Date().toISOString();
  const rem = await remember(s, { to: recipient, text: `Letterlock agent testnet run ${stamp}: sealed by the agent from POST /remember.`, openWith });
  check("remember", rem.status === 200 && "opened" in rem && rem.opened!.matches, rem);

  const t = await task(s, { from: recipient, text: `testnet task ${stamp}: what did I seal to agent:10260?`, openWith, sealTo: "health" });
  const tOk = t.status === 200 && "opened" in t && !!t.opened && t.opened.inReplyToMatches && t.opened.quotesTask && t.opened.sealedToMatches;
  const { envelope: taskEnvelope, ...tShown } = t as typeof t & { envelope: unknown };
  check("task", tOk, tShown);

  // refusals: none of these may send anything
  const nonceMid = await rpc.getTransactionCount({ address: wallet });
  const replay = await post(base, "/task", { from: recipient, envelope: taskEnvelope });
  check("task replayed → 409", replay.status === 409, { status: replay.status, code: replay.body.error?.code });
  const other = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`).address;
  const held = s.health.key.held as { epoch: number; publicKey: string };
  const fresh = await seal({
    chainId: 10143,
    directory: s.ll.directory,
    to: { recipient: s.health.agent.recipient, publicKey: fromHex(held.publicKey), epoch: held.epoch },
    plaintext: encodeTask({ replyTo: recipient as `0x${string}`, nonce: newNonce(), issuedAt: Math.floor(Date.now() / 1000), text: "posted with another from" }),
  });
  const stolen = await post(base, "/task", { from: other, envelope: fresh });
  check("task posted with another from → 403", stolen.status === 403, { status: stolen.status, code: stolen.body.error?.code });
  const noKey = await post(base, "/remember", { to: other, text: "to an address without a key" });
  check("remember to an address without a key → 422", noKey.status === 422, { status: noKey.status, code: noKey.body.error?.code });
  const long = await post(base, "/remember", { to: recipient, text: "x".repeat(1001) });
  check("1001 characters → 400", long.status === 400, { status: long.status, code: long.body.error?.code });
  const nonceAfter = await rpc.getTransactionCount({ address: wallet });
  check("refusals sent nothing", nonceAfter === nonceMid, { nonceBefore: nonceMid, nonceAfter });

  // the kill switch, on a second copy of the same bundle loaded with AGENT_ENABLED unset
  delete process.env.AGENT_ENABLED;
  const off = (await import(`${bundle}?disabled`)) as { default: Parameters<typeof serve>[0] };
  const offServer = await serve(off.default, 0);
  const offAddress = offServer.address();
  const offBase = `http://127.0.0.1:${typeof offAddress === "object" && offAddress ? offAddress.port : 0}`;
  const disabled = await post(offBase, "/remember", { to: recipient, text: "kill switch" });
  offServer.close();
  check("AGENT_ENABLED unset → 503", disabled.status === 503 && disabled.body.error?.code === "AGENT_DISABLED", { status: disabled.status, code: disabled.body.error?.code });

  const balanceAfter = await rpc.getBalance({ address: wallet });
  console.log(
    JSON.stringify(
      {
        network: "Monad testnet (10143)",
        agent: base,
        wallet,
        transactions: nonceAfter - nonceBefore,
        spent: `${formatEther(balanceBefore - balanceAfter)} MON (testnet)`,
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  server.close();
}
