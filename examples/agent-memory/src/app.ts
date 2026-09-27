// The agent's HTTP surface, on web-standard Request/Response:
//
//   POST /remember  { to, text }        resolve(to) → seal(text) → drop from the agent's wallet
//   POST /task      { from, envelope }  open a task sealed to agent:<id> → answer it sealed to `from` → drop
//   GET  /health                        chain, directory, wallet balance, the agent's key, limits
//
// Nothing a request carries is logged: no text, no envelope, no address, no IP. A log line holds the route, the
// status, an error code, the drop's transaction hash, the envelope's size and the time taken.
import {
  DEPLOYMENTS,
  LetterlockError,
  canonicalRecipient,
  decodeEnvelope,
  fingerprint,
  open,
  seal,
  toHex,
  type Envelope,
  type Recipient,
  type ResolvedKey,
} from "letterlock";
import { formatEther, isAddress, zeroAddress } from "viem";
import { agentKeyFromSeed, agentPublicKey } from "./agent-key.ts";
import { agentChain, type AgentChain } from "./chain.ts";
import { ConfigError, loadConfig, type AgentConfig, type Window } from "./config.ts";
import { CORS, HttpError, failure, json, readJson } from "./http.ts";
import { RateLimiter, ReplayGuard, charCount, type Verdict } from "./limits.ts";
import { TaskError, buildReply, encodeReply, parseTask } from "./task.ts";

export type LogEntry = {
  readonly route: string;
  readonly status: number;
  readonly ms: number;
  readonly code?: string;
  readonly tx?: string;
  readonly bytes?: number;
};

export type AppDeps = {
  readonly config: AgentConfig;
  /** Default: agentChain(config), created on first use. */
  readonly chain?: AgentChain;
  /** Default: Date.now. */
  readonly now?: () => number;
  /** Default: one JSON line on stdout. */
  readonly log?: (entry: LogEntry) => void;
};

export type App = (request: Request, ip: string) => Promise<Response>;

type Outcome = { readonly res: Response; readonly code?: string; readonly tx?: string; readonly bytes?: number };

/** The SDK's error codes (docs/SPEC.md §5) as HTTP statuses. */
const STATUS: Readonly<Record<string, number>> = {
  INPUT_INVALID: 400,
  NO_KEY_PUBLISHED: 422,
  TAMPERED: 422,
  WRONG_KEY: 422,
  EPOCH_MISMATCH: 422,
  INSUFFICIENT_FUNDS: 503,
  CHAIN_UNAVAILABLE: 502,
};

const withoutCode = (e: LetterlockError): string => (e.message.startsWith(`${e.code}: `) ? e.message.slice(e.code.length + 2) : e.message);

const outcomeOf = (e: unknown): Outcome => {
  if (e instanceof HttpError) return { res: failure(e.status, e.code, e.message, e.headers), code: e.code };
  if (e instanceof TaskError) return { res: failure(422, e.code, e.message), code: e.code };
  if (e instanceof LetterlockError) {
    const status = STATUS[e.code] ?? 500;
    const tail = status === 422 || status === 400 || status === 503 ? "; nothing was sent" : "";
    return { res: failure(status, e.code, `${withoutCode(e)}${tail}`), code: e.code };
  }
  if (e instanceof ConfigError) return { res: failure(503, "MISCONFIGURED", e.message), code: "MISCONFIGURED" };
  return { res: failure(500, "INTERNAL", "the agent failed unexpectedly; nothing more is known"), code: "INTERNAL" };
};

const rateLimited = (v: Extract<Verdict, { ok: false }>, what: string): HttpError =>
  new HttpError(429, "RATE_LIMITED", `${what}: at most ${v.window.max} per ${v.window.windowSec} s from one address; try again in ${v.retryAfterSec} s`, {
    "retry-after": String(v.retryAfterSec),
  });

const objectBody = (body: unknown): Record<string, unknown> => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "INPUT_INVALID", "the body must be a JSON object");
  return body as Record<string, unknown>;
};

/** A recipient from a request field. A mixed-case address must carry its EIP-55 checksum: a mistyped digit is refused, not sealed to. */
export const recipientField = (value: unknown, field: string): Recipient => {
  if (typeof value !== "string") throw new HttpError(400, "INPUT_INVALID", `"${field}" must be a string: 0x<40 hex> or agent:<id>`);
  const v = value.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(v) && !isAddress(v, { strict: true }))
    throw new HttpError(400, "INPUT_INVALID", `"${field}" is not a valid EIP-55 checksummed address: check it, or send it in lower case`);
  try {
    return canonicalRecipient(v);
  } catch {
    throw new HttpError(400, "INPUT_INVALID", `"${field}" must be 0x<40 hex> or agent:<decimal id>`);
  }
};

export const textField = (value: unknown, maxChars: number): string => {
  if (typeof value !== "string") throw new HttpError(400, "INPUT_INVALID", '"text" must be a string');
  if (!value.isWellFormed()) throw new HttpError(400, "INPUT_INVALID", '"text" is not valid Unicode (an unpaired surrogate)');
  if (value.trim() === "") throw new HttpError(400, "INPUT_INVALID", '"text" is empty');
  const chars = charCount(value);
  if (chars > maxChars) throw new HttpError(400, "TEXT_TOO_LONG", `"text" is ${chars} characters; the agent seals at most ${maxChars}`);
  return value;
};

const envelopeField = (value: unknown): Envelope => {
  if (typeof value !== "string" && (typeof value !== "object" || value === null || Array.isArray(value)))
    throw new HttpError(400, "INPUT_INVALID", '"envelope" must be the envelope JSON (docs/SPEC.md §3), as an object or a string');
  try {
    return decodeEnvelope(typeof value === "string" ? value : JSON.stringify(value));
  } catch (e) {
    if (e instanceof LetterlockError) throw new HttpError(STATUS[e.code] ?? 400, e.code, `"envelope": ${withoutCode(e)}`);
    throw e;
  }
};

const routeOf = (url: URL): string => {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  // Vercel rewrites /remember, /task and /health to the one function, naming the route in the query
  if (path === "/api/agent") return `/${url.searchParams.get("route") ?? ""}`;
  return path;
};

const MON = (wei: bigint) => `${formatEther(wei)} MON`;

export const createApp = (deps: AppDeps): App => {
  const { config } = deps;
  const { limits } = config;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((e: LogEntry) => console.log(JSON.stringify({ service: "letterlock-agent-memory", ...e })));
  let chainInstance = deps.chain;
  const chain = (): AgentChain => (chainInstance ??= agentChain(config));

  const requests = new RateLimiter(limits.perIpRequests);
  const drops = new RateLimiter(limits.perIpDrops);
  const replays = new ReplayGuard((limits.taskMaxAgeSec + limits.taskMaxSkewSec + 60) * 1000);
  const agent: Recipient = `agent:${config.agentId}`;

  const ready = (needsSeed: boolean) => {
    if (!config.enabled) throw new HttpError(503, "AGENT_DISABLED", "the agent is switched off (AGENT_ENABLED is not true); nothing was sent");
    if (!config.account) throw new HttpError(503, "NOT_CONFIGURED", "the agent has no wallet configured; nothing was sent");
    if (needsSeed && !config.seed) throw new HttpError(503, "NOT_CONFIGURED", "the agent has no key seed configured; nothing was opened");
    return config.account;
  };

  /** The checks between "the recipient has a key" and "send": the daily cap, the gas reserve, then this IP's drops. */
  const gate = async (c: AgentChain, ip: string, t: number) => {
    const address = config.account!.address;
    const [today, balance] = await Promise.all([c.dropsToday(address, t), c.balance(address).then((b) => b, () => undefined)]);
    if (balance === undefined) throw new HttpError(502, "CHAIN_UNAVAILABLE", "the RPC did not answer eth_getBalance; nothing was sent");
    if (today.used >= limits.dailyDrops) {
      const wait = Math.max(1, Math.ceil((today.resetsAt - t) / 1000));
      throw new HttpError(429, "DAILY_CAP", `the agent has sent its ${limits.dailyDrops} drops for today (UTC); it sends again from ${new Date(today.resetsAt).toISOString()}`, {
        "retry-after": String(wait),
      });
    }
    if (balance < limits.minBalanceWei)
      throw new HttpError(503, "GAS_RESERVE", `the agent's wallet is down to its reserve (${MON(balance)}, keeps ${MON(limits.minBalanceWei)}); nothing was sent`);
    const v = drops.take(ip, t);
    if (!v.ok) throw rateLimited(v, "drops");
  };

  const dropped = (c: AgentChain, envelope: Envelope, d: { transactionHash: `0x${string}`; blockNumber: bigint; gasUsed: bigint; bytes: number }) => ({
    dropTx: d.transactionHash,
    kid: envelope.kid,
    epoch: envelope.epoch,
    directory: c.directory,
    chainId: c.chainId,
    recipient: envelope.recipient,
    bytes: d.bytes,
    blockNumber: d.blockNumber,
    gasUsed: d.gasUsed,
    explorer: `${c.explorer}/tx/${d.transactionHash}`,
  });

  const remember = async (request: Request, ip: string, t: number): Promise<Outcome> => {
    const account = ready(false);
    const pre = drops.check(ip, t);
    if (!pre.ok) throw rateLimited(pre, "drops");
    const body = objectBody(await readJson(request, limits.bodyMaxBytes));
    const to = recipientField(body.to, "to");
    const text = textField(body.text, limits.textMaxChars);
    const c = chain();
    const key: ResolvedKey = await c.resolve(to); // NO_KEY_PUBLISHED: nothing is sent to an address without a key
    await gate(c, ip, t);
    const plaintext = new TextEncoder().encode(text);
    const envelope = await seal({ chainId: c.chainId, directory: c.directory, to: key, plaintext });
    plaintext.fill(0);
    const d = await c.drop(account, envelope);
    return {
      res: json(200, {
        envelope,
        ...dropped(c, envelope, d),
        note: "Sealed to the recipient's published key. The agent kept no copy and cannot open it; only the recipient's passkey can.",
      }),
      tx: d.transactionHash,
      bytes: d.bytes,
    };
  };

  const task = async (request: Request, ip: string, t: number): Promise<Outcome> => {
    const account = ready(true);
    const pre = drops.check(ip, t);
    if (!pre.ok) throw rateLimited(pre, "drops");
    const body = objectBody(await readJson(request, limits.bodyMaxBytes));
    const from = recipientField(body.from, "from");
    const envelope = envelopeField(body.envelope);
    const c = chain();
    if (envelope.chainId !== c.chainId || envelope.directory !== c.directory.toLowerCase())
      throw new HttpError(422, "WRONG_DIRECTORY", `the task is sealed for chain ${envelope.chainId}, directory ${envelope.directory}; this agent reads chain ${c.chainId}, directory ${c.directory}`);
    if (envelope.recipient !== agent)
      throw new HttpError(422, "NOT_FOR_THIS_AGENT", `the task is sealed to ${envelope.recipient}; this agent is ${agent}`);
    if (envelope.epoch < config.keyFirstEpoch)
      throw new HttpError(422, "EPOCH_NOT_HELD", `the task is sealed to ${agent}'s epoch ${envelope.epoch} key, which this agent does not hold (its keys start at epoch ${config.keyFirstEpoch}); resolve ${agent} again and seal to the key it returns`);

    const keys = agentKeyFromSeed(config.seed!, config.agentId, envelope.epoch);
    let plaintext: Uint8Array;
    try {
      plaintext = await open(envelope, keys);
    } finally {
      keys.secretKey.fill(0);
    }
    const nowSec = Math.floor(t / 1000);
    let parsed;
    try {
      parsed = parseTask(plaintext, { nowSec, maxAgeSec: limits.taskMaxAgeSec, maxSkewSec: limits.taskMaxSkewSec, textMaxChars: limits.textMaxChars });
    } finally {
      plaintext.fill(0);
    }
    if (parsed.replyTo !== from)
      throw new HttpError(403, "REPLY_TO_MISMATCH", "the task names another reply address inside its seal; the agent answers only the address sealed in the task");
    if (replays.has(parsed.nonce, t)) throw new HttpError(409, "REPLAYED", "the agent has already answered a task with this nonce; seal a new task");
    replays.add(parsed.nonce, t);

    let replyKey: ResolvedKey;
    try {
      replyKey = await c.resolve(from);
      await gate(c, ip, t);
    } catch (e) {
      replays.delete(parsed.nonce); // nothing was sent: the same task may be posted again
      throw e;
    }
    const reply = buildReply({ agent, task: parsed, sealedTo: { recipient: agent, epoch: envelope.epoch, kid: fingerprint(keys.publicKey) }, openedAt: nowSec });
    const replyBytes = encodeReply(reply);
    const replyEnvelope = await seal({ chainId: c.chainId, directory: c.directory, to: replyKey, plaintext: replyBytes });
    replyBytes.fill(0);
    const d = await c.drop(account, replyEnvelope);
    return {
      res: json(200, {
        reply: replyEnvelope,
        ...dropped(c, replyEnvelope, d),
        inReplyTo: parsed.nonce,
        task: { recipient: agent, epoch: envelope.epoch, kid: envelope.kid },
        note: "The answer is sealed to the task's reply address. The agent kept no copy and cannot open it.",
      }),
      tx: d.transactionHash,
      bytes: d.bytes,
    };
  };

  let healthCache: { at: number; status: number; body: unknown } | undefined;
  const health = async (t: number): Promise<Outcome> => {
    if (healthCache && t - healthCache.at < 5000) return { res: json(healthCache.status, healthCache.body) };
    const c = chain();
    const address = config.account?.address;
    const none = Promise.reject(new Error("no wallet"));
    none.catch(() => undefined);
    const [bal, nonce, today, published] = await Promise.allSettled([
      address ? c.balance(address) : none,
      address ? c.nonce(address) : none,
      address ? c.dropsToday(address, t) : none,
      c.resolve(agent),
    ]);
    const pub = published.status === "fulfilled" ? published.value : undefined;
    const noAgentPath = published.status === "rejected" && /AgentPathDisabled/.test(String((published.reason as Error)?.message));
    const heldEpoch = pub && pub.epoch >= config.keyFirstEpoch ? pub.epoch : config.keyFirstEpoch;
    const held = config.seed ? agentPublicKey(config.seed, config.agentId, heldEpoch) : undefined;
    const matches = !!pub && !!held && pub.epoch === held.epoch && toHex(pub.publicKey) === toHex(held.publicKey);
    const registry = DEPLOYMENTS[config.chain].identityRegistry;
    const ok = config.enabled && !!address && !!held && bal.status === "fulfilled" && bal.value >= limits.minBalanceWei && (matches || noAgentPath);
    const window = (w: Window) => ({ max: w.max, perSeconds: w.windowSec });
    const body = {
      ok,
      enabled: config.enabled,
      agent: {
        agentId: config.agentId,
        recipient: agent,
        registry: registry === zeroAddress ? null : `eip155:${c.chainId}:${registry}`,
        card: `${config.publicUrl}/.well-known/agent-card.json`,
      },
      chain: { chainId: c.chainId, network: c.network, directory: c.directory, explorer: c.explorer },
      wallet: address
        ? {
            address,
            balance: bal.status === "fulfilled" ? MON(bal.value) : null,
            balanceWei: bal.status === "fulfilled" ? bal.value : null,
            nonce: nonce.status === "fulfilled" ? nonce.value : null,
            reserve: MON(limits.minBalanceWei),
          }
        : null,
      key: {
        held: held ? { epoch: held.epoch, kid: held.kid, publicKey: `0x${toHex(held.publicKey)}` } : null,
        published: pub
          ? { epoch: pub.epoch, kid: pub.kid, publicKey: `0x${toHex(pub.publicKey)}`, updatedAt: pub.updatedAt }
          : noAgentPath
            ? `none: the ${c.network} directory holds no agent keys (no ERC-8004 registry)`
            : published.status === "rejected" && published.reason instanceof LetterlockError
              ? published.reason.code
              : null,
        matches,
      },
      limits: {
        textMaxChars: limits.textMaxChars,
        bodyMaxBytes: limits.bodyMaxBytes,
        perIpDrops: limits.perIpDrops.map(window),
        perIpRequests: limits.perIpRequests.map(window),
        dailyDrops: {
          cap: limits.dailyDrops,
          used: today.status === "fulfilled" ? today.value.used : null,
          resetsAt: today.status === "fulfilled" ? new Date(today.value.resetsAt).toISOString() : null,
          counted: today.status === "fulfilled" ? today.value.source : null,
        },
        taskMaxAgeSec: limits.taskMaxAgeSec,
      },
      checkedAt: new Date(t).toISOString(),
    };
    healthCache = { at: t, status: ok ? 200 : 503, body };
    return { res: json(healthCache.status, body) };
  };

  return async (request, ip) => {
    const t = now();
    const url = new URL(request.url);
    const route = routeOf(url);
    let out: Outcome;
    try {
      if (request.method === "OPTIONS") out = { res: new Response(null, { status: 204, headers: CORS }) };
      else {
        const any = requests.take(ip, t);
        if (!any.ok) throw rateLimited(any, "requests");
        const methods: Readonly<Record<string, string>> = { "/remember": "POST", "/task": "POST", "/health": "GET, HEAD" };
        const allowed = methods[route];
        if (!allowed) throw new HttpError(404, "NOT_FOUND", "the agent answers POST /remember, POST /task and GET /health");
        if (!allowed.split(", ").includes(request.method))
          throw new HttpError(405, "METHOD_NOT_ALLOWED", `${route} takes ${allowed}`, { allow: `${allowed}, OPTIONS` });
        if (route === "/remember") out = await remember(request, ip, t);
        else if (route === "/task") out = await task(request, ip, t);
        else {
          out = await health(t);
          if (request.method === "HEAD") out = { res: new Response(null, { status: out.res.status, headers: out.res.headers }) };
        }
      }
    } catch (e) {
      out = outcomeOf(e);
    }
    log({
      route,
      status: out.res.status,
      ms: now() - t,
      ...(out.code ? { code: out.code } : {}),
      ...(out.tx ? { tx: out.tx } : {}),
      ...(out.bytes !== undefined ? { bytes: out.bytes } : {}),
    });
    return out.res;
  };
};

/** The app for a process environment. A configuration error answers every request with 503 MISCONFIGURED (no secret in it). */
export const createAppFromEnv = (env: Readonly<Record<string, string | undefined>>): App => {
  try {
    return createApp({ config: loadConfig(env) });
  } catch (e) {
    const message = e instanceof ConfigError ? e.message : "the agent's configuration could not be read";
    console.error(JSON.stringify({ service: "letterlock-agent-memory", startup: "MISCONFIGURED", message }));
    return async () => failure(503, "MISCONFIGURED", message);
  }
};
