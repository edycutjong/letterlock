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
const { askAgent, AgentError } = await import("../lib/agent.ts");

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
