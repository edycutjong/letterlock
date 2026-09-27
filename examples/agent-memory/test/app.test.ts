// The HTTP surface with a fake chain (test/fake-chain.ts) and the SDK's real seal and open: validation, limits, the
// kill switch, the open-and-answer flow of /task with a software key, /health, and what the logs never contain.
import { randomBytes } from "node:crypto";
import { deriveAgentKeyPair, deriveKeyPair, fingerprint, open, seal, toHex, type Envelope, type Recipient } from "letterlock";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentPublicKey } from "../src/agent-key.ts";
import { createApp, createAppFromEnv, type LogEntry } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { encodeTask, newNonce, parseReply, type TaskReply } from "../src/task.ts";
import { DIRECTORY, fakeChain } from "./fake-chain.ts";

const T0 = Date.UTC(2026, 8, 27, 10, 0, 0);
const IP = "203.0.113.7";
const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const setup = (env: Record<string, string | undefined> = {}) => {
  const privateKey = generatePrivateKey();
  const seedHex = toHex(randomBytes(32));
  const config = loadConfig({ AGENT_ENABLED: "true", LETTERLOCK_AGENT_PRIVATE_KEY: privateKey, LETTERLOCK_AGENT_KEY_SEED: seedHex, ...env });
  const chain = fakeChain();
  const logs: LogEntry[] = [];
  const clock = { t: T0 };
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
  const post = async (path: string, body: unknown, ip = IP, headers: Record<string, string> = {}) => {
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

  it("keeps a gas reserve: below 0.1 MON it sends nothing (503 GAS_RESERVE); an RPC that fails is 502", async () => {
    const s = setup();
    s.chain.state.balance = 10n ** 17n - 1n;
    const r = await s.post("/remember", { to: s.maya.address, text: "x" });
    expect([r.status, r.body.error.code]).toEqual([503, "GAS_RESERVE"]);
    s.chain.state.balance = 10n ** 17n;
    expect((await s.post("/remember", { to: s.maya.address, text: "x" })).status).toBe(200);
    s.chain.state.balanceFails = true;
    expect((await s.post("/remember", { to: s.maya.address, text: "x" })).body.error.code).toBe("CHAIN_UNAVAILABLE");
    expect(s.chain.dropped).toHaveLength(1);
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
    expect([stolen.status, stolen.body.error.code]).toEqual([403, "REPLY_TO_MISMATCH"]);
    expect(s.chain.dropped).toHaveLength(0);
    expect((await s.post("/task", { from: s.maya.address, envelope })).status).toBe(200); // the sender's own request still works
  });

  it("answers each nonce once: a replayed task is 409 REPLAYED", async () => {
    const s = setup();
    const envelope = await s.sealTask();
    expect((await s.post("/task", { from: s.maya.address, envelope })).status).toBe(200);
    const again = await s.post("/task", { from: s.maya.address, envelope });
    expect([again.status, again.body.error.code]).toEqual([409, "REPLAYED"]);
    expect(s.chain.dropped).toHaveLength(1);
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
      [s.sealTask({ issuedAt: Math.floor(T0 / 1000) - 601 }), 422, "TASK_STALE"],
      [s.sealTask({ text: "x".repeat(1001) }), 422, "TASK_TOO_LONG"],
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
      agent: { agentId: "10260", recipient: "agent:10260", registry: "eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", card: "https://letterlock-agent.vercel.app/.well-known/agent-card.json" },
      chain: { chainId: 143, directory: DIRECTORY },
      wallet: { address, balance: "1 MON", reserve: "0.1 MON" },
      key: { held: { epoch: 2, kid: s.agentKey!.kid }, published: { epoch: 2, kid: s.agentKey!.kid }, matches: true },
      limits: { textMaxChars: 1000, dailyDrops: { cap: 150, used: 0, counted: "chain" } },
    });
    const body = JSON.stringify(r.body).toLowerCase();
    expect(body).not.toContain(s.privateKey.slice(2).toLowerCase());
    expect(body).not.toContain(s.seedHex.toLowerCase());
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
    const pre = await s.app(s.request("OPTIONS", "/remember"), IP);
    expect([pre.status, pre.headers.get("access-control-allow-origin"), pre.headers.get("access-control-allow-headers")]).toEqual([204, "*", "content-type"]);
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

  it("defaults: mainnet, agent 10260, keys from epoch 2, 150 drops a day, 0.1 MON reserve, 1000 characters", () => {
    const c = loadConfig({});
    expect([c.chain, c.agentId, c.keyFirstEpoch, c.limits.dailyDrops, c.limits.minBalanceWei, c.limits.textMaxChars, c.enabled]).toEqual(["monad", 10260n, 2, 150, 10n ** 17n, 1000, false]);
    expect(() => loadConfig({ LETTERLOCK_CHAIN: "ethereum" })).toThrow(/LETTERLOCK_CHAIN/);
    expect(() => loadConfig({ AGENT_DAILY_DROP_CAP: "-1" })).toThrow(/AGENT_DAILY_DROP_CAP/);
  });
});
