// The HTTP surface with a fake chain (test/fake-chain.ts) and the SDK's real seal and open: validation, limits, the
// kill switch, the open-and-answer flow of /task with a software key, /health, CORS, and what the logs never contain.
import { randomBytes } from "node:crypto";
import { deriveAgentKeyPair, deriveKeyPair, encodeEnvelope, fingerprint, open, seal, toHex, type Envelope, type Recipient } from "letterlock";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentPublicKey } from "../src/agent-key.ts";
import { createApp, createAppFromEnv, type LogEntry } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { QUOTE_CHARS, encodeTask, newNonce, parseReply, type TaskReply } from "../src/task.ts";
import { DIRECTORY, GWEI, dropGas, fakeChain } from "./fake-chain.ts";

const T0 = Date.UTC(2026, 8, 27, 10, 0, 0);
const IP = "203.0.113.7";
const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const setup = (env: Record<string, string | undefined> = {}) => {
  const privateKey = generatePrivateKey();
  const seedHex = toHex(randomBytes(32));
  const config = loadConfig({ AGENT_ENABLED: "true", LETTERLOCK_AGENT_PRIVATE_KEY: privateKey, LETTERLOCK_AGENT_KEY_SEED: seedHex, ...env });
  const logs: LogEntry[] = [];
  const clock = { t: T0 };
  const chain = fakeChain({ limits: config.limits, now: () => clock.t });
  const app = createApp({ config, chain, now: () => clock.t, log: (e) => logs.push(e) });
  // the agent's key, published at epoch 2 as on mainnet (epoch 1 there is the deploy smoke test's demo key)
  const agentKey = config.seed ? agentPublicKey(config.seed, 10260n, 2) : undefined;
  if (agentKey) chain.keys.set("agent:10260", { publicKey: agentKey.publicKey, epoch: 2 });
  // Maya: an address with a published key
  const maya = { address: privateKeyToAccount(generatePrivateKey()).address, keys: deriveKeyPair(randomBytes(32), 1) };
  chain.keys.set(maya.address.toLowerCase() as Recipient, { publicKey: maya.keys.publicKey, epoch: 1 });
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Request(`https://agent.test${path}`, {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const post = async (path: string, body: unknown, ip: string = IP, headers: Record<string, string> = {}) => {
    const res = await app(request("POST", path, body, headers), ip);
    return { status: res.status, headers: res.headers, body: (await res.json()) as Json };
  };
  const get = async (path: string, ip = IP) => {
    const res = await app(request("GET", path), ip);
    return { status: res.status, headers: res.headers, body: (await res.json()) as Json };
  };
  /** A task sealed to agent:10260 (its epoch-2 key unless `to` says otherwise), as a caller would seal it. */
  const sealTask = (o: Partial<{ replyTo: string; nonce: string; issuedAt: number; text: string }> = {}, to?: { recipient?: string; publicKey?: Uint8Array; epoch?: number; chainId?: number; directory?: `0x${string}` }) =>
    seal({
      chainId: to?.chainId ?? 143,
      directory: to?.directory ?? DIRECTORY,
      to: { recipient: to?.recipient ?? "agent:10260", publicKey: to?.publicKey ?? agentKey!.publicKey, epoch: to?.epoch ?? 2 },
      plaintext: encodeTask({ replyTo: (o.replyTo ?? maya.address) as Recipient, nonce: o.nonce ?? newNonce(), issuedAt: o.issuedAt ?? Math.floor(clock.t / 1000), text: o.text ?? "summarize my lease in one line" }),
    });
  return { config, chain, logs, clock, app, agentKey, maya, post, get, request, sealTask, privateKey, seedHex };
};

afterEach(() => vi.restoreAllMocks());

describe("POST /remember", () => {
  it("resolves the recipient, seals the text to its key, drops it once, and answers with the envelope and the drop", async () => {
    const s = setup();
    const r = await s.post("/remember", { to: s.maya.address, text: "the dentist moved to Thursday 10:40" });
    expect(r.status).toBe(200);
    expect(s.chain.dropped).toHaveLength(1);
    expect(r.body.envelope).toEqual(s.chain.dropped[0]);
    expect(r.body).toMatchObject({
      dropTx: `0x${"1".padStart(64, "0")}`,
      kid: fingerprint(s.maya.keys.publicKey),
      epoch: 1,
      directory: DIRECTORY,
      chainId: 143,
      recipient: s.maya.address.toLowerCase(),
      explorer: `https://monadvision.com/tx/0x${"1".padStart(64, "0")}`,
    });
    expect(text(await open(r.body.envelope as Envelope, s.maya.keys))).toBe("the dentist moved to Thursday 10:40");
  });

  it("seals to an agent too: agent:<id> resolves through keyOfAgent", async () => {
    const s = setup();
    const other = deriveAgentKeyPair(randomBytes(32), 4412n, 1);
    s.chain.keys.set("agent:4412", { publicKey: other.publicKey, epoch: 1 });
    const r = await s.post("/remember", { to: "agent:4412", text: "for the other agent" });
    expect(r.status).toBe(200);
    expect(text(await open(r.body.envelope as Envelope, other))).toBe("for the other agent");
  });

  it("takes 1000 characters, counted as code points (1000 emoji), and refuses 1001", async () => {
    const s = setup();
    expect((await s.post("/remember", { to: s.maya.address, text: "🔒".repeat(1000) })).status).toBe(200);
    const r = await s.post("/remember", { to: s.maya.address, text: "a".repeat(1001) });
    expect([r.status, r.body.error.code]).toEqual([400, "TEXT_TOO_LONG"]);
    expect(s.chain.dropped).toHaveLength(1);
  });

  it("refuses malformed requests before anything is read from the chain or sent", async () => {
    const s = setup();
    const resolve = vi.spyOn(s.chain, "resolve");
    const wrongCase = s.maya.address.replace(/[a-f]/, (c) => c.toUpperCase()); // breaks the EIP-55 checksum
    const cases: [unknown, number, string][] = [
      [{ text: "x" }, 400, "INPUT_INVALID"],
      [{ to: "0x1234", text: "x" }, 400, "INPUT_INVALID"],
      [{ to: 42, text: "x" }, 400, "INPUT_INVALID"],
      [{ to: wrongCase, text: "x" }, 400, "INPUT_INVALID"],
      [{ to: s.maya.address }, 400, "INPUT_INVALID"],
      [{ to: s.maya.address, text: "" }, 400, "INPUT_INVALID"],
      [{ to: s.maya.address, text: " \n\t " }, 400, "INPUT_INVALID"],
      [{ to: s.maya.address, text: ["x"] }, 400, "INPUT_INVALID"],
      [[1, 2], 400, "INPUT_INVALID"],
      ["not json", 400, "INPUT_INVALID"],
    ];
    for (const [body, status, code] of cases) {
      const r = await s.post("/remember", body);
      expect([r.status, r.body.error.code], JSON.stringify(body)).toEqual([status, code]);
    }
    expect(wrongCase).not.toBe(s.maya.address);
    const lower = await s.post("/remember", { to: s.maya.address.toLowerCase(), text: "lower-case is fine" });
    expect(lower.status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(s.chain.dropped).toHaveLength(1);
  });

  it("reads only JSON, and at most 16 KiB of it", async () => {
    const s = setup();
    const res = await s.app(new Request("https://agent.test/remember", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }), IP);
    expect(res.status).toBe(415);
    const big = await s.post("/remember", { to: s.maya.address, text: "x".repeat(17_000) });
    expect([big.status, big.body.error.code]).toEqual([413, "BODY_TOO_LARGE"]);
    const declared = await s.post("/remember", { to: s.maya.address, text: "x" }, IP, { "content-length": "20000" });
    expect(declared.status).toBe(413);
    expect(s.chain.dropped).toHaveLength(0);
  });

  it("sends nothing to a recipient without a published key (422 NO_KEY_PUBLISHED)", async () => {
    const s = setup();
    const r = await s.post("/remember", { to: privateKeyToAccount(generatePrivateKey()).address, text: "hello?" });
    expect([r.status, r.body.error.code]).toEqual([422, "NO_KEY_PUBLISHED"]);
    expect(r.body.error.message).toMatch(/nothing was sent$/);
    expect(s.chain.dropped).toHaveLength(0);
  });

  it("the kill switch: unless AGENT_ENABLED is exactly true, nothing is sent (503 AGENT_DISABLED)", async () => {
    for (const value of [undefined, "false", "TRUE", "1"]) {
      const s = setup({ AGENT_ENABLED: value });
      const r = await s.post("/remember", { to: s.maya.address, text: "x" });
      expect([r.status, r.body.error.code], String(value)).toEqual([503, "AGENT_DISABLED"]);
      expect(s.chain.dropped).toHaveLength(0);
      expect((await s.get("/health")).body.enabled).toBe(false);
    }
  });

  it("without a wallet it answers 503 NOT_CONFIGURED", async () => {
    const s = setup({ LETTERLOCK_AGENT_PRIVATE_KEY: undefined });
    const r = await s.post("/remember", { to: s.maya.address, text: "x" });
    expect([r.status, r.body.error.code]).toEqual([503, "NOT_CONFIGURED"]);
  });

  it("limits drops per IP: 5 per 10 minutes and 20 per day, with Retry-After; other IPs are unaffected", async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) expect((await s.post("/remember", { to: s.maya.address, text: `note ${i}` })).status).toBe(200);
    const sixth = await s.post("/remember", { to: s.maya.address, text: "note 5" });
    expect([sixth.status, sixth.body.error.code, sixth.headers.get("retry-after")]).toEqual([429, "RATE_LIMITED", "600"]);
    expect((await s.post("/remember", { to: s.maya.address, text: "from elsewhere" }, "198.51.100.9")).status).toBe(200);
    s.clock.t += 600_000;
    for (let i = 0; i < 5; i++) expect((await s.post("/remember", { to: s.maya.address, text: `later ${i}` })).status).toBe(200);
    for (let round = 0; round < 2; round++) {
      s.clock.t += 600_000;
      for (let i = 0; i < 5; i++) expect((await s.post("/remember", { to: s.maya.address, text: `round ${round}.${i}` })).status).toBe(200);
    }
    s.clock.t += 600_000; // 20 drops from this IP today: the day window is full though the 10-minute one is empty
    const day = await s.post("/remember", { to: s.maya.address, text: "one more" });
    expect([day.status, day.body.error.code]).toEqual([429, "RATE_LIMITED"]);
    expect(Number(day.headers.get("retry-after"))).toBe(86_400 - 2400);
    expect(s.chain.dropped).toHaveLength(21);
  });

  it("concurrent requests from one IP cannot run past its limit: the check is repeated when the drop is counted", async () => {
    const s = setup();
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => s.post("/remember", { to: s.maya.address, text: `burst ${i}` })));
    expect(all.filter((r) => r.status === 200)).toHaveLength(5);
    expect(all.filter((r) => r.status === 429)).toHaveLength(3);
    expect(s.chain.dropped).toHaveLength(5);
  });

  it("a request refused before the drop does not use up the IP's drops", async () => {
    const s = setup();
    for (let i = 0; i < 8; i++) await s.post("/remember", { to: privateKeyToAccount(generatePrivateKey()).address, text: "no key there" });
    for (let i = 0; i < 5; i++) expect((await s.post("/remember", { to: s.maya.address, text: `note ${i}` })).status).toBe(200);
  });

  it("stops at the daily drop cap (counted onchain), until 00:00 UTC", async () => {
    const s = setup();
    s.chain.state.usedToday = 150;
    const r = await s.post("/remember", { to: s.maya.address, text: "x" });
    expect([r.status, r.body.error.code]).toEqual([429, "DAILY_CAP"]);
    expect(Number(r.headers.get("retry-after"))).toBe(14 * 3600); // T0 is 10:00 UTC
    expect(s.chain.dropped).toHaveLength(0);
    const capped = setup({ AGENT_DAILY_DROP_CAP: "3" });
    capped.chain.state.usedToday = 2;
    expect((await capped.post("/remember", { to: capped.maya.address, text: "third" })).status).toBe(200);
    expect((await capped.post("/remember", { to: capped.maya.address, text: "fourth" })).body.error.code).toBe("DAILY_CAP");
  });

  it("keeps a gas reserve, counting the drop's own cost: a drop that would take the wallet below 0.1 MON is not sent (503 GAS_RESERVE); an RPC that fails is 502", async () => {
    const s = setup({ AGENT_DAILY_SPEND_PERCENT: "100" }); // the reserve alone decides here
    s.chain.state.balance = 10n ** 17n - 1n;
    const below = await s.post("/remember", { to: s.maya.address, text: "x" });
    expect([below.status, below.body.error.code]).toEqual([503, "GAS_RESERVE"]);
    // exactly the reserve: the balance is not below it, but the drop's own cost would take it there
    s.chain.state.balance = 10n ** 17n;
    const at = await s.post("/remember", { to: s.maya.address, text: "x" });
    expect([at.status, at.body.error.code]).toEqual([503, "GAS_RESERVE"]);
    expect(at.body.error.message).toMatch(/can cost up to 0\.\d+ MON; the wallet holds 0\.1 MON and keeps 0\.1 MON; nothing was sent$/);
    // the reserve plus one drop's cost at its fee cap (182.4 gwei) is enough, and the wallet ends at or above the reserve
    s.chain.state.balance = 10n ** 17n + 30_000_000n * GWEI;
    expect((await s.post("/remember", { to: s.maya.address, text: "x" })).status).toBe(200);
    expect(s.chain.state.balance >= 10n ** 17n).toBe(true);
    s.chain.state.balanceFails = true;
    expect((await s.post("/remember", { to: s.maya.address, text: "x" })).body.error.code).toBe("CHAIN_UNAVAILABLE");
    expect(s.chain.dropped).toHaveLength(1);
  });

  it("the daily allowance follows the wallet: at most 25% of what it held at 00:00 UTC, at the most a drop can cost (250,000 gas at the price it pays)", async () => {
    const s = setup();
    const start = 988_393_318_000_000_000n; // the wallet on 2026-09-27; at 102 gwei a drop costs at most 0.0255 MON
    s.chain.state.balance = start;
    const largest = "🔒".repeat(1000); // what someone spending the wallet would send: the largest note
    for (let i = 0; i < 9; i++) expect((await s.post("/remember", { to: s.maya.address, text: largest }, `198.51.100.${i}`)).status, `drop ${i}`).toBe(200);
    const tenth = await s.post("/remember", { to: s.maya.address, text: largest }, "198.51.100.200");
    expect([tenth.status, tenth.body.error.code]).toEqual([429, "DAILY_CAP"]);
    expect(tenth.body.error.message).toContain("the agent has sent 9 of the 9 drops it allows itself today");
    expect(Number(tenth.headers.get("retry-after"))).toBe(14 * 3600);
    expect(s.chain.dropped).toHaveLength(9);
    expect((start - s.chain.state.balance) * 4n <= start).toBe(true); // a quarter of the wallet at most
    // a refill counts at once
    s.chain.state.balance += 5n * 10n ** 18n;
    expect((await s.post("/remember", { to: s.maya.address, text: "after the refill" }, "198.51.100.201")).status).toBe(200);
    s.clock.t += 5000;
    expect((await s.get("/health", "198.51.100.202")).body.limits.dailyDrops).toMatchObject({ cap: 150, spendPercent: 25, used: 10 });
  });

  it("concurrent requests from many IPs cannot spend past the reserve: each drop is checked when it is signed, one at a time", async () => {
    const s = setup({ AGENT_DAILY_SPEND_PERCENT: "100" });
    s.chain.state.maxFeePerGas = s.chain.state.baseFeePerGas + s.chain.state.maxPriorityFeePerGas; // pays its fee cap: the test counts exactly
    const sample = await seal({ chainId: 143, directory: DIRECTORY, to: { recipient: s.maya.address.toLowerCase() as Recipient, publicKey: s.maya.keys.publicKey, epoch: 1 }, plaintext: utf8("burst 0") });
    const cost = dropGas(encodeEnvelope(sample).length) * s.chain.state.maxFeePerGas;
    s.chain.state.balance = 10n ** 17n + 3n * cost + cost / 2n; // the reserve, and three drops and a half
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => s.post("/remember", { to: s.maya.address, text: `burst ${i}` }, `203.0.113.${10 + i}`)));
    expect(all.filter((r) => r.status === 200)).toHaveLength(3);
    expect(all.filter((r) => r.status === 503).map((r) => r.body.error.code)).toEqual(Array(5).fill("GAS_RESERVE"));
    expect(s.chain.dropped).toHaveLength(3);
    expect(s.chain.state.balance >= 10n ** 17n).toBe(true);
  });

  it("refuses to sign a drop above the gas cap (422 DROP_TOO_COSTLY), and the refusal does not use up the IP's drops", async () => {
    const s = setup({ AGENT_MAX_DROP_GAS: "100000" });
    const big = await s.post("/remember", { to: s.maya.address, text: "🔒".repeat(1000) }); // 5,585 bytes: about 248,600 gas
    expect([big.status, big.body.error.code]).toEqual([422, "DROP_TOO_COSTLY"]);
    expect(big.body.error.message).toMatch(/^this drop needs \d+ gas; the agent signs no drop above 100000; nothing was sent$/);
    expect(s.chain.dropped).toHaveLength(0);
    for (let i = 0; i < 5; i++) expect((await s.post("/remember", { to: s.maya.address, text: `small ${i}` })).status).toBe(200);
  });
});

describe("POST /task", () => {
  it("opens a task sealed to agent:10260 with the key derived from the seed, and answers it sealed to the sender", async () => {
    const s = setup();
    const envelope = await s.sealTask({ text: "remind me what I asked" });
    const r = await s.post("/task", { from: s.maya.address, envelope });
    expect(r.status).toBe(200);
    expect(s.chain.dropped).toHaveLength(1);
    expect(r.body.reply).toEqual(s.chain.dropped[0]);
    expect(r.body).toMatchObject({ recipient: s.maya.address.toLowerCase(), epoch: 1, task: { recipient: "agent:10260", epoch: 2, kid: s.agentKey!.kid } });
    const reply = parseReply(await open(r.body.reply as Envelope, s.maya.keys)) as TaskReply;
    expect(reply).toMatchObject({ v: 1, from: "agent:10260", inReplyTo: r.body.inReplyTo, task: { chars: 22, sealedTo: { recipient: "agent:10260", epoch: 2, kid: s.agentKey!.kid } } });
    expect(reply.text).toContain("“remind me what I asked”");
  });

  it("answers an agent through its own published key (agent to agent)", async () => {
    const s = setup();
    const caller = deriveAgentKeyPair(randomBytes(32), 4412n, 3);
    s.chain.keys.set("agent:4412", { publicKey: caller.publicKey, epoch: 3 });
    const r = await s.post("/task", { from: "agent:4412", envelope: await s.sealTask({ replyTo: "agent:4412", text: "ping from 4412" }) });
    expect(r.status).toBe(200);
    expect(r.body.recipient).toBe("agent:4412");
    expect(parseReply(await open(r.body.reply as Envelope, caller)).text).toContain("“ping from 4412”");
  });

  it("answers only the address sealed inside the task: a copied task posted with another from is refused", async () => {
    const s = setup();
    const mallory = { address: privateKeyToAccount(generatePrivateKey()).address, keys: deriveKeyPair(randomBytes(32), 1) };
    s.chain.keys.set(mallory.address.toLowerCase() as Recipient, { publicKey: mallory.keys.publicKey, epoch: 1 });
    const envelope = await s.sealTask({ text: "my bank PIN hint" });
    const stolen = await s.post("/task", { from: mallory.address, envelope });
    expect([stolen.status, stolen.body.error.code]).toEqual([422, "TASK_REFUSED"]);
    expect(s.chain.dropped).toHaveLength(0);
    expect((await s.post("/task", { from: s.maya.address, envelope })).status).toBe(200); // the sender's own request still works
  });

  it("answers each nonce once per server instance: a replayed task is refused", async () => {
    const s = setup();
    const envelope = await s.sealTask();
    expect((await s.post("/task", { from: s.maya.address, envelope })).status).toBe(200);
    const again = await s.post("/task", { from: s.maya.address, envelope });
    expect([again.status, again.body.error.code]).toEqual([422, "TASK_REFUSED"]);
    expect(s.chain.dropped).toHaveLength(1);
    // the nonce lives in this instance's memory: another instance (a second createApp) answers the copy again
    const other = createApp({ config: s.config, chain: s.chain, now: () => s.clock.t, log: () => undefined });
    const res = await other(s.request("POST", "/task", { from: s.maya.address, envelope }), IP);
    expect(res.status).toBe(200);
    expect(s.chain.dropped).toHaveLength(2);
  });

  it("every refusal of a task that opened is one answer: whoever posts a copy learns nothing about what is sealed in it", async () => {
    const s = setup();
    const mallory = privateKeyToAccount(generatePrivateKey()).address;
    s.chain.keys.set(mallory.toLowerCase() as Recipient, { publicKey: deriveKeyPair(randomBytes(32), 1).publicKey, epoch: 1 });
    const nowSec = Math.floor(T0 / 1000);
    const answered = await s.sealTask({ text: "answered once already" });
    expect((await s.post("/task", { from: s.maya.address, envelope: answered })).status).toBe(200);
    const bad = await seal({ chainId: 143, directory: DIRECTORY, to: { recipient: "agent:10260", publicKey: s.agentKey!.publicKey, epoch: 2 }, plaintext: utf8('{"v":1,"replyTo":"nope"}') });
    const cases: [string, { from: string; envelope: Envelope }][] = [
      ["a wrong guess of the sealed replyTo", { from: mallory, envelope: await s.sealTask() }],
      ["the right replyTo, sealed 601 s ago", { from: s.maya.address, envelope: await s.sealTask({ issuedAt: nowSec - 601 }) }],
      ["the right replyTo, sealed 61 s ahead", { from: s.maya.address, envelope: await s.sealTask({ issuedAt: nowSec + 61 }) }],
      ["the right replyTo, 1,001 characters", { from: s.maya.address, envelope: await s.sealTask({ text: "x".repeat(1001) }) }],
      ["the right replyTo, a nonce answered already", { from: s.maya.address, envelope: answered }],
      ["sealed JSON that is not a task", { from: s.maya.address, envelope: bad }],
    ];
    const answers = [];
    for (const [what, body] of cases) {
      const r = await s.post("/task", body);
      answers.push([r.status, JSON.stringify(r.body)]);
      expect([r.status, r.body.error.code], what).toEqual([422, "TASK_REFUSED"]);
      // nothing sealed is repeated: not the time, the length, the nonce or an address
      for (const leak of [String(nowSec - 601), String(nowSec + 61), "1001", s.maya.address.toLowerCase(), mallory.toLowerCase()])
        expect(r.body.error.message, `${what}: ${leak}`).not.toContain(leak);
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(s.chain.dropped).toHaveLength(1);
  });

  it("quotes at most 80 characters of the task, so no task makes its answer cost more than a short note", async () => {
    const s = setup();
    // the longest reply address there is: an agent id of 78 digits
    const far = `agent:${2n ** 256n - 2n}` as Recipient;
    const farKeys = deriveAgentKeyPair(randomBytes(32), 2n ** 256n - 2n, 1);
    s.chain.keys.set(far, { publicKey: farKeys.publicKey, epoch: 1 });
    for (const text of ["\u0001".repeat(1000), "🔒".repeat(1000), '"\\'.repeat(500), `a${"\u2028".repeat(999)}`]) {
      const r = await s.post("/task", { from: far, envelope: await s.sealTask({ replyTo: far, text }) });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // 1,000 control characters quoted in full made an 8,981-byte answer (384,237 gas on Monad mainnet)
      expect(r.body.bytes, JSON.stringify(text.slice(0, 2))).toBeLessThanOrEqual(1700);
      const reply = parseReply(await open(r.body.reply as Envelope, farKeys));
      expect(reply.task.chars).toBe(Array.from(text).length);
      expect(reply.text).toContain(`${reply.task.sha256}, beginning “`);
      expect(Array.from(reply.text.slice(reply.text.indexOf("“") + 1, reply.text.indexOf("”"))).length).toBe(QUOTE_CHARS + 1); // 80 and "…"
    }
  });

  it("a task refused before anything was sent can be posted again (the nonce is released)", async () => {
    const s = setup();
    const envelope = await s.sealTask();
    s.chain.keys.delete(s.maya.address.toLowerCase() as Recipient);
    const r = await s.post("/task", { from: s.maya.address, envelope });
    expect([r.status, r.body.error.code]).toEqual([422, "NO_KEY_PUBLISHED"]);
    s.chain.keys.set(s.maya.address.toLowerCase() as Recipient, { publicKey: s.maya.keys.publicKey, epoch: 1 });
    expect((await s.post("/task", { from: s.maya.address, envelope })).status).toBe(200);
  });

  it("refuses stale tasks, other agents', other directories', epochs it does not hold, other keys' and altered ones", async () => {
    const s = setup();
    const stranger = deriveAgentKeyPair(randomBytes(32), 10260n, 2);
    const altered = await s.sealTask();
    const cases: [Promise<Envelope>, number, string][] = [
      [s.sealTask({ issuedAt: Math.floor(T0 / 1000) - 601 }), 422, "TASK_REFUSED"],
      [s.sealTask({ text: "x".repeat(1001) }), 422, "TASK_REFUSED"],
      [s.sealTask({}, { recipient: "agent:10261" }), 422, "NOT_FOR_THIS_AGENT"],
      [s.sealTask({}, { chainId: 10143 }), 422, "WRONG_DIRECTORY"],
      [s.sealTask({}, { directory: "0x3Da5f339E20AB7325ffBb9df57Fb5656ca1f8b3a" }), 422, "WRONG_DIRECTORY"],
      [s.sealTask({}, { epoch: 1, publicKey: stranger.publicKey }), 422, "EPOCH_NOT_HELD"],
      [s.sealTask({}, { publicKey: stranger.publicKey }), 422, "WRONG_KEY"],
      [Promise.resolve({ ...altered, ct: altered.ct.slice(0, -2) + (altered.ct.endsWith("AA") ? "AQ" : "AA") }), 422, "TAMPERED"],
    ];
    for (const [envelope, status, code] of cases) {
      const r = await s.post("/task", { from: s.maya.address, envelope: await envelope });
      expect([r.status, r.body.error.code], code).toEqual([status, code]);
    }
    expect(s.chain.dropped).toHaveLength(0);
  });

  it("takes a task whose directory is spelled with its EIP-55 checksum: the case is not part of what info binds", async () => {
    const s = setup();
    const envelope = await s.sealTask();
    const checksummed = { ...envelope, directory: getAddress(envelope.directory) };
    expect(checksummed.directory).not.toBe(envelope.directory);
    const r = await s.post("/task", { from: s.maya.address, envelope: checksummed });
    expect(r.status).toBe(200);
  });

  it("refuses a missing or malformed envelope, and answers 503 without a key seed", async () => {
    const s = setup();
    for (const envelope of [undefined, "nope", 7, { v: 1 }]) {
      const r = await s.post("/task", { from: s.maya.address, envelope });
      expect(r.status, JSON.stringify(envelope)).toBe(400);
    }
    const noSeed = setup({ LETTERLOCK_AGENT_KEY_SEED: undefined });
    const r = await noSeed.post("/task", { from: noSeed.maya.address, envelope: await s.sealTask() });
    expect([r.status, r.body.error.code]).toEqual([503, "NOT_CONFIGURED"]);
  });

  it("takes the envelope as a JSON string as well as an object", async () => {
    const s = setup();
    const r = await s.post("/task", { from: s.maya.address, envelope: JSON.stringify(await s.sealTask()) });
    expect(r.status).toBe(200);
  });
});

describe("GET /health", () => {
  it("reports the chain, the directory, the wallet, the agent's key (held = published) and the limits, and no secret", async () => {
    const s = setup();
    const address = privateKeyToAccount(s.privateKey).address;
    const r = await s.get("/health");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      enabled: true,
      agent: { agentId: "10260", recipient: "agent:10260", registry: "eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", card: "https://agent.letterlock.edycu.dev/.well-known/agent-card.json" },
      chain: { chainId: 143, directory: DIRECTORY },
      wallet: { address, balance: "100 MON", reserve: "0.1 MON" },
      key: { held: { epoch: 2, kid: s.agentKey!.kid }, published: { epoch: 2, kid: s.agentKey!.kid }, matches: true },
      limits: {
        textMaxChars: 1000,
        dailyDrops: { cap: 150, spendPercent: 25, allowedToday: 150, used: 0, counted: "chain" },
        maxDropGas: "250000",
        gasPriceGwei: 102,
        maxDropCost: "0.0255 MON",
        taskNonce: "answered once per server instance, remembered for 720 s",
      },
    });
    expect(r.body.limits.perIpCounted).toMatch(/^in each server instance's memory: best effort/);
    const body = JSON.stringify(r.body).toLowerCase();
    expect(body).not.toContain(s.privateKey.slice(2).toLowerCase());
    expect(body).not.toContain(s.seedHex.toLowerCase());
  });

  it("is 503 when today's allowance is used up, and says how many drops the wallet allows today", async () => {
    const s = setup();
    s.chain.state.balance = 988_393_318_000_000_000n - 9n * 248_600n * 102n * GWEI; // after 9 of the largest notes today
    s.chain.state.usedToday = 9;
    const r = await s.get("/health");
    expect([r.status, r.body.ok, r.body.limits.dailyDrops.allowedToday, r.body.limits.dailyDrops.used]).toEqual([503, false, 9, 9]);
  });

  it("is 503 when the published key is not the one the agent holds", async () => {
    const s = setup();
    s.chain.keys.set("agent:10260", { publicKey: deriveAgentKeyPair(randomBytes(32), 10260n, 2).publicKey, epoch: 2 });
    const r = await s.get("/health");
    expect([r.status, r.body.ok, r.body.key.matches]).toEqual([503, false, false]);
  });

  it("answers HEAD without a body, and reuses its answer for 5 s", async () => {
    const s = setup();
    const head = await s.app(s.request("HEAD", "/health"), IP);
    expect([head.status, await head.text()]).toEqual([200, ""]);
    s.chain.state.usedToday = 7;
    expect((await s.get("/health")).body.limits.dailyDrops.used).toBe(0);
    s.clock.t += 5000;
    expect((await s.get("/health")).body.limits.dailyDrops.used).toBe(7);
  });
});

describe("routing", () => {
  it("answers methods and paths it does not serve with 405 and 404, preflights with 204 and CORS", async () => {
    const s = setup();
    const wrong = await s.get("/remember");
    expect([wrong.status, wrong.headers.get("allow")]).toEqual([405, "POST, OPTIONS"]);
    expect((await s.post("/health", {})).status).toBe(405);
    expect((await s.get("/nope")).status).toBe(404);
    const pre = await s.app(s.request("OPTIONS", "/remember", undefined, { origin: "https://app.letterlock.edycu.dev", "access-control-request-method": "POST" }), IP);
    expect([pre.status, pre.headers.get("access-control-allow-origin"), pre.headers.get("access-control-allow-headers")]).toEqual([204, "https://app.letterlock.edycu.dev", "content-type"]);
    expect((await s.get("/remember/")).status).toBe(405); // a trailing slash is the same route
  });

  it("serves the routes Vercel rewrites to /api/agent?route=…", async () => {
    const s = setup();
    expect((await s.get("/api/agent?route=health")).body.agent.recipient).toBe("agent:10260");
    expect((await s.post("/api/agent?route=remember", { to: s.maya.address, text: "via the rewrite" })).status).toBe(200);
  });

  it("limits requests of any kind per IP: 60 a minute", async () => {
    const s = setup();
    for (let i = 0; i < 60; i++) await s.get("/health");
    const r = await s.get("/health");
    expect([r.status, r.body.error.code]).toEqual([429, "RATE_LIMITED"]);
    expect((await s.get("/health", "198.51.100.9")).status).toBe(200);
  });
});

describe("CORS", () => {
  const APP = "https://app.letterlock.edycu.dev";
  const OTHER = "https://some-page.example";
  const preflight = (s: ReturnType<typeof setup>, origin: string, method = "POST") =>
    s.app(s.request("OPTIONS", "/remember", undefined, { origin, "access-control-request-method": method, "access-control-request-headers": "content-type" }), IP);

  it("pages of the Letterlock app and of the agent may POST; any other page's preflight and POST are refused, and nothing is sent", async () => {
    const s = setup();
    for (const origin of [APP, "https://agent.letterlock.edycu.dev"]) {
      const ok = await preflight(s, origin);
      expect([ok.status, ok.headers.get("access-control-allow-origin"), ok.headers.get("access-control-allow-headers"), ok.headers.get("vary")]).toEqual([204, origin, "content-type", "origin"]);
    }
    const no = await preflight(s, OTHER);
    expect([no.status, no.headers.get("access-control-allow-origin")]).toEqual([403, null]);
    const post = await s.post("/remember", { to: s.maya.address, text: "asked from another site" }, IP, { origin: OTHER });
    expect([post.status, post.body.error.code, post.headers.get("access-control-allow-origin")]).toEqual([403, "ORIGIN_NOT_ALLOWED", null]);
    const task = await s.post("/task", { from: s.maya.address, envelope: await s.sealTask() }, IP, { origin: "null" });
    expect([task.status, task.body.error.code]).toEqual([403, "ORIGIN_NOT_ALLOWED"]);
    expect(s.chain.dropped).toHaveLength(0);
    const fromApp = await s.post("/remember", { to: s.maya.address, text: "asked from the app" }, IP, { origin: APP });
    expect([fromApp.status, fromApp.headers.get("access-control-allow-origin")]).toEqual([200, APP]);
    const fromServer = await s.post("/remember", { to: s.maya.address, text: "asked from a server" }); // no Origin: not a browser
    expect([fromServer.status, fromServer.headers.get("access-control-allow-origin")]).toEqual([200, null]);
    expect(s.chain.dropped).toHaveLength(2);
  });

  it("the app's retired origin (the rpId SDK 0.1.0 pinned, now a 308 to the app) and the agent's former host may not POST", async () => {
    const s = setup();
    for (const origin of ["https://letterlock-app.vercel.app", "https://letterlock-agent.vercel.app"]) {
      const no = await preflight(s, origin);
      expect([origin, no.status, no.headers.get("access-control-allow-origin")]).toEqual([origin, 403, null]);
      const post = await s.post("/remember", { to: s.maya.address, text: "asked from a page opened before the move" }, IP, { origin });
      expect([origin, post.status, post.body.error.code]).toEqual([origin, 403, "ORIGIN_NOT_ALLOWED"]);
    }
    expect(s.chain.dropped).toHaveLength(0);
    // reads are not a grant: the former host's own page still reads /health from any origin
    const h = await s.app(s.request("GET", "/health", undefined, { origin: "https://letterlock-agent.vercel.app" }), IP);
    expect([h.status, h.headers.get("access-control-allow-origin")]).toEqual([200, "*"]);
  });

  it("reads stay open to any page: GET /health, and a GET preflight", async () => {
    const s = setup();
    const h = await s.app(s.request("GET", "/health", undefined, { origin: OTHER }), IP);
    expect([h.status, h.headers.get("access-control-allow-origin")]).toEqual([200, "*"]);
    const pre = await s.app(s.request("OPTIONS", "/health", undefined, { origin: OTHER, "access-control-request-method": "GET" }), IP);
    expect([pre.status, pre.headers.get("access-control-allow-origin")]).toEqual([204, "*"]);
  });

  it("AGENT_ALLOWED_ORIGINS replaces the list; an origin with a path or upper case is a configuration error", async () => {
    const s = setup({ AGENT_ALLOWED_ORIGINS: "http://localhost:3000, https://staging.example" });
    expect(s.config.allowedOrigins).toEqual(["http://localhost:3000", "https://staging.example"]);
    expect((await preflight(s, "http://localhost:3000")).status).toBe(204);
    expect((await preflight(s, APP)).status).toBe(403);
    for (const bad of ["https://a.example/", "https://A.example", "app.letterlock.edycu.dev", "*"])
      expect(() => loadConfig({ AGENT_ALLOWED_ORIGINS: bad }), bad).toThrow(/AGENT_ALLOWED_ORIGINS/);
  });
});

describe("logs", () => {
  it("hold routes, statuses, codes, transaction hashes and sizes: never the text, the task, an address or an IP", async () => {
    const s = setup();
    const secretText = "the safe code is 4-8-15-16";
    const secretTask = "forward my medical results";
    await s.post("/remember", { to: s.maya.address, text: secretText });
    await s.post("/task", { from: s.maya.address, envelope: await s.sealTask({ text: secretTask }) });
    await s.post("/remember", { to: privateKeyToAccount(generatePrivateKey()).address, text: secretText });
    const all = JSON.stringify(s.logs).toLowerCase();
    for (const leak of [secretText, secretTask, s.maya.address.toLowerCase().slice(2), IP, s.seedHex, s.privateKey.slice(2)])
      expect(all, leak).not.toContain(leak.toLowerCase());
    expect(s.logs.map((l) => [l.route, l.status, l.code ?? null])).toEqual([["/remember", 200, null], ["/task", 200, null], ["/remember", 422, "NO_KEY_PUBLISHED"]]);
    expect(s.logs[0]).toMatchObject({ tx: `0x${"1".padStart(64, "0")}`, bytes: expect.any(Number) });
  });

  it("the default logger prints one JSON line per request with the same fields", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    const privateKey = generatePrivateKey();
    const config = loadConfig({ AGENT_ENABLED: "true", LETTERLOCK_AGENT_PRIVATE_KEY: privateKey, LETTERLOCK_AGENT_KEY_SEED: toHex(randomBytes(32)) });
    const chain = fakeChain();
    const maya = deriveKeyPair(randomBytes(32), 1);
    const address = privateKeyToAccount(generatePrivateKey()).address;
    chain.keys.set(address.toLowerCase() as Recipient, { publicKey: maya.publicKey, epoch: 1 });
    const app = createApp({ config, chain });
    await app(new Request("https://agent.test/remember", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: address, text: "a private line" }) }), IP);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ service: "letterlock-agent-memory", route: "/remember", status: 200 });
    expect(lines[0]).not.toContain("a private line");
    expect(lines[0]!.toLowerCase()).not.toContain(address.slice(2).toLowerCase());
  });
});

describe("configuration", () => {
  it("a malformed secret answers every request with 503 MISCONFIGURED, and the value is never repeated", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secret = "0x" + "zz".repeat(32);
    for (const env of [{ LETTERLOCK_AGENT_PRIVATE_KEY: secret }, { LETTERLOCK_AGENT_KEY_SEED: secret }, { LETTERLOCK_AGENT_KEY_SEED: "0x" + "00".repeat(32) }, { LETTERLOCK_AGENT_PRIVATE_KEY: "0x" + "ff".repeat(32) }]) {
      const app = createAppFromEnv({ AGENT_ENABLED: "true", ...env });
      const res = await app(new Request("https://agent.test/health"), IP);
      const body = await res.text();
      expect(res.status, JSON.stringify(env)).toBe(503);
      expect(body).toContain("MISCONFIGURED");
      expect(body).not.toContain(Object.values(env)[0]!.slice(2, 20));
    }
  });

  it("defaults: mainnet, agent 10260, keys from epoch 2, at most 150 drops and 25% of the wallet a day, 250,000 gas a drop, 0.1 MON reserve, 1000 characters", () => {
    const c = loadConfig({});
    expect([c.chain, c.agentId, c.keyFirstEpoch, c.limits.dailyDrops, c.limits.dailySpendPercent, c.limits.maxDropGas, c.limits.minBalanceWei, c.limits.textMaxChars, c.enabled])
      .toEqual(["monad", 10260n, 2, 150, 25, 250_000n, 10n ** 17n, 1000, false]);
    expect(c.allowedOrigins).toEqual(["https://app.letterlock.edycu.dev", "https://agent.letterlock.edycu.dev"]);
    expect(c.publicUrl).toBe("https://agent.letterlock.edycu.dev");
    expect(() => loadConfig({ LETTERLOCK_CHAIN: "ethereum" })).toThrow(/LETTERLOCK_CHAIN/);
    expect(() => loadConfig({ AGENT_DAILY_DROP_CAP: "-1" })).toThrow(/AGENT_DAILY_DROP_CAP/);
    expect(() => loadConfig({ AGENT_DAILY_SPEND_PERCENT: "0" })).toThrow(/AGENT_DAILY_SPEND_PERCENT/);
    expect(() => loadConfig({ AGENT_MAX_DROP_GAS: "20000" })).toThrow(/AGENT_MAX_DROP_GAS/);
  });
});
