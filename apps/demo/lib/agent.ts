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
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

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
    throw new AgentError("UNREACHABLE", `the reference agent at ${AGENT_URL} did not answer`);
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
