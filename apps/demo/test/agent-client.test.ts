// The page's side of the reference agent (lib/agent.ts, askAgent). When the POST cannot be read at all, the page asks
// the agent's /health (which answers CORS to anyone) to tell an agent that is down from Vercel's firewall answering its
// per-network limit with a 429 the browser hides. Requests go to a stand-in for fetch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";

registerHooks({
  load: (url, context, nextLoad) =>
    url.startsWith("file:") && url.endsWith(".json")
      ? { format: "module", source: `export default ${readFileSync(new URL(url), "utf8")};`, shortCircuit: true }
      : nextLoad(url, context),
});
process.env.NEXT_PUBLIC_LETTERLOCK_AGENT_URL = "https://agent.example";
const { askAgent, AgentError, agentFailureCopy } = await import("../lib/agent.ts");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** POST /remember throws as a CORS-less answer does in a browser; GET /health does what `health` says. */
const postHidden = (health: "up" | "down" | "503") => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    seen.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/remember")) throw new TypeError("Failed to fetch");
    if (health === "down") throw new TypeError("Failed to fetch");
    return new Response("{}", { status: health === "up" ? 200 : 503 });
  }) as typeof fetch;
  return seen;
};

const failure = async () => {
  try {
    await askAgent("0x0000000000000000000000000000000000000001", "hi");
  } catch (e) {
    assert.ok(e instanceof AgentError);
    return e;
  }
  assert.fail("askAgent resolved");
};

test("an unreadable POST while /health answers is reported as the network's limit, not as the agent being down", async () => {
  const seen = postHidden("up");
  const e = await failure();
  assert.equal(e.code, "LIKELY_RATE_LIMITED");
  assert.match(e.message, /is up/);
  assert.match(e.message, /5 requests per network every 10 minutes/);
  assert.doesNotMatch(e.message, /did not answer/);
  assert.deepEqual(seen, ["POST https://agent.example/remember", "GET https://agent.example/health"]);
});

test("a /health that answers 503 (the agent is up but cannot send) still means the POST was held back, not lost", async () => {
  postHidden("503");
  assert.equal((await failure()).code, "LIKELY_RATE_LIMITED");
});

test("when /health does not answer either, the agent is reported unreachable, with the limit named as the other cause", async () => {
  postHidden("down");
  const e = await failure();
  assert.equal(e.code, "UNREACHABLE");
  assert.match(e.message, /did not answer, and neither did its \/health/);
  assert.match(e.message, /more than 5 times in 10 minutes/);
});

test("the agent's own 429, which carries CORS, is read as it is", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "too many drops from this address" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const e = await failure();
  assert.equal(e.code, "RATE_LIMITED");
  assert.equal(e.status, 429);
});

// ---- what /judge says after a failed request: "Nothing was sent" only when that is known ------------------------------
// A judge told "nothing was sent" asks again, and a second drop leaves the agent's wallet. The agent's own answers
// (examples/agent-memory, src/app.ts) say "nothing was sent" where it knows; a 4xx is a request it refused before sealing.

const answering = (status: number, body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
};

const saysNotSent = (copy: { message: string }) => {
  assert.match(copy.message, /nothing was sent/i);
  assert.equal(copy.message.match(/nothing was sent/gi)?.length, 1, `said once: ${copy.message}`);
  assert.doesNotMatch(copy.message, /not known/);
};
const saysUnknown = (copy: { title: string; message: string }) => {
  assert.doesNotMatch(`${copy.title} ${copy.message}`, /nothing was sent|did not deliver/i);
  assert.match(copy.message, /Whether a letter went out is not known/);
  assert.match(copy.message, /step 3 counts the letters in your inbox/);
};

test("an agent that fails after it may have sent is never reported as having sent nothing", async () => {
  for (const [status, code, message] of [
    [500, "INTERNAL", "the agent failed unexpectedly; nothing more is known"],
    [502, "CHAIN_UNAVAILABLE", "the RPC did not answer while the drop's receipt was awaited"],
    [503, "MISCONFIGURED", "LETTERLOCK_AGENT_KEY_SEED is not set"],
  ] as const) {
    answering(status, { error: { code, message } });
    const e = await failure();
    assert.equal(e.nothingSent, false, code);
    saysUnknown(agentFailureCopy(e));
  }
  // an answer of 200 without a transaction
  answering(200, { ok: true });
  saysUnknown(agentFailureCopy(await failure()));
});

test("an answer the page could not read leaves it open whether a letter went out", async () => {
  for (const health of ["up", "down"] as const) {
    postHidden(health);
    const e = await failure();
    assert.equal(e.nothingSent, false, e.code);
    saysUnknown(agentFailureCopy(e));
  }
});

test("a refusal (a 4xx), and the agent's own 'nothing was sent', say so, once", async () => {
  for (const [status, code, message] of [
    [429, "RATE_LIMITED", "drops: at most 3 per 3600 s from one address in this server instance; try again in 60 s"],
    [429, "DAILY_CAP", "the agent has sent 150 of the 150 drops it allows itself today; nothing was sent"],
    [400, "TEXT_TOO_LONG", '"text" is 1001 characters; the agent seals at most 1000'],
    [422, "NO_KEY_PUBLISHED", "no key is published for 0x0000000000000000000000000000000000000001; nothing was sent"],
    [503, "GAS_RESERVE", "the agent's wallet is down to its reserve (0.05 MON, keeps 0.05 MON); nothing was sent"],
    [502, "CHAIN_UNAVAILABLE", "the RPC did not answer eth_getBalance or eth_gasPrice; nothing was sent"],
    [503, "AGENT_DISABLED", "the agent is switched off (AGENT_ENABLED is not true); nothing was sent"],
  ] as const) {
    answering(status, { error: { code, message } });
    const e = await failure();
    assert.equal(e.nothingSent, true, code);
    const copy = agentFailureCopy(e);
    assert.equal(copy.title, "The agent did not deliver");
    saysNotSent(copy);
    assert.ok(copy.message.startsWith(`${message} (${code})`), copy.message);
  }
});

test("/judge shows the agent's failure through agentFailureCopy, and never adds 'Nothing was sent' itself", () => {
  const judge = readFileSync(new URL("../app/judge/JudgeRoute.tsx", import.meta.url), "utf8");
  assert.match(judge, /agentFailureCopy\(e\)/);
  assert.doesNotMatch(judge, /Nothing was sent/i);
});
