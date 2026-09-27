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

/**
 * True only when it is known that no letter went out: the page never asked, or the agent refused the request (a 4xx:
 * its checks run before it seals anything), or its own message says nothing was sent (its reserve, its switch, an RPC
 * that failed before it signed). Anything else (a 500 that "knows nothing more", a 502 the SDK's drop raised after it
 * broadcast, an answer the page could not read) leaves it open.
 */
export const knownNotSent = (code: string, message: string, status: number | undefined): boolean =>
  code === "NO_AGENT" || (status !== undefined && status >= 400 && status < 500) || /\bnothing was sent\b/i.test(message);

export class AgentError extends Error {
  readonly code: string;
  readonly status?: number;
  /** knownNotSent(): false means it is not known whether a letter went out */
  readonly nothingSent: boolean;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.status = status;
    this.nothingSent = knownNotSent(code, message, status);
  }
}

/**
 * What /judge shows for a failed request: "Nothing was sent" only when that is known (AgentError.nothingSent), and
 * otherwise that it is not known, with where to look before asking again, so a judge does not spend a second drop on
 * a letter that did go out.
 */
export const agentFailureCopy = (e: AgentError): { readonly title: string; readonly message: string } => {
  const said = `${e.message} (${e.code}).`;
  if (e.nothingSent) return { title: "The agent did not deliver", message: /\bnothing was sent\b/i.test(e.message) ? said : `${said} Nothing was sent.` };
  return {
    title: "The agent did not confirm a delivery",
    message: `${said} Whether a letter went out is not known: step 3 counts the letters in your inbox, so look there before you ask again.`,
  };
};

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
