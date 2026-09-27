"use client";

// The reference agent's API, called from the browser (it answers CORS): POST /remember { to, text } resolves `to`
// in the directory, seals `text` to that key and drops the envelope from the agent's own wallet. It answers with the
// drop's transaction, or { error: { code, message } }. Nothing here stands in for it: if it does not answer, the page
// says so and nothing is shown as sent.
import { AGENT_URL } from "./chain.ts";

/** The agent reads at most this many characters of text (examples/agent-memory, textMaxChars). */
export const AGENT_TEXT_MAX = 1_000;

export type AgentDrop = {
  readonly dropTx: `0x${string}`;
  readonly kid?: string;
  readonly epoch?: number;
  readonly recipient?: string;
  readonly bytes?: number;
  readonly blockNumber?: string | number;
  readonly explorer?: string;
};

export class AgentError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.status = status;
  }
}

/** The firewall's limit on POST requests per network (examples/agent-memory, vercel-firewall.json). */
export const AGENT_POSTS_PER_WINDOW = 5;
export const AGENT_WINDOW_MINUTES = 10;

// A POST that the page cannot read at all is either an agent that is down, or Vercel's firewall answering its per-IP
// limit with a 429 that carries no CORS headers (the browser hides it). GET /health answers CORS to anyone, so it
// tells the two apart: if it answers, the agent is up and this network is most likely being held back.
const unreadable = async (base: string): Promise<AgentError> => {
  const limit = `the agent takes ${AGENT_POSTS_PER_WINDOW} requests per network every ${AGENT_WINDOW_MINUTES} minutes`;
  let up = false;
  try {
    const h = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
    up = h.status === 200 || h.status === 503;
  } catch {
    up = false;
  }
  return up
    ? new AgentError(
        "LIKELY_RATE_LIMITED",
        `the reference agent is up (its /health answers), but its answer to this request could not be read: most likely ${limit}, so wait up to ${AGENT_WINDOW_MINUTES} minutes and try again`,
      )
    : new AgentError(
        "UNREACHABLE",
        `the reference agent at ${base} did not answer, and neither did its /health; if this network asked more than ${AGENT_POSTS_PER_WINDOW} times in ${AGENT_WINDOW_MINUTES} minutes, wait and try again`,
      );
};

export const askAgent = async (to: string, text: string): Promise<AgentDrop> => {
  if (!AGENT_URL) throw new AgentError("NO_AGENT", "this build of the app names no reference agent (it writes on Monad mainnet)");
  let res: Response;
  try {
    res = await fetch(`${AGENT_URL}/remember`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, text }),
    });
  } catch {
    throw await unreadable(AGENT_URL);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (res.ok && typeof b.dropTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(b.dropTx)) return b as unknown as AgentDrop;
  const err = (b.error ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof err.code === "string" ? err.code : `HTTP_${res.status}`;
  const message =
    typeof err.message === "string"
      ? err.message
      : res.ok
        ? "the agent answered without a transaction"
        : `the agent answered HTTP ${res.status}${res.status === 404 ? ": its /remember endpoint is not live" : ""}`;
  throw new AgentError(code, message, res.status);
};
