// Timing one call for scripts/bench.ts, and counting the HTTP requests it made. viem's HTTP transport retries a failed
// request (three times by default, with a backoff) inside the one call, so a transient RPC error would otherwise show
// up as one slow sample. The SDK's client takes no transport option, so the retries cannot be switched off for it:
// instead every request through fetch (which viem's transport calls) is counted, and a call that made more requests
// than it should, or fewer, is a failure, never a sample.

export type RequestCounter = { readonly count: number };

let counter: { count: number } | undefined;

/** Wraps globalThis.fetch once per process; every request after this is counted. */
export const countRequests = (): RequestCounter => {
  if (counter) return counter;
  const c = { count: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    c.count++;
    return real(...args);
  }) as typeof fetch;
  counter = c;
  return c;
};

export type Timed<T> =
  | { readonly ok: true; readonly value: T; readonly ms: number; readonly requests: number }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly requests: number };

/** Times f() with performance.now(); it must make exactly `requests` HTTP requests to count as a sample. */
export const timeCall = async <T>(requests: RequestCounter, expected: number, f: () => Promise<T>): Promise<Timed<T>> => {
  const before = requests.count;
  const t0 = performance.now();
  try {
    const value = await f();
    const ms = performance.now() - t0;
    const made = requests.count - before;
    if (made !== expected)
      return {
        ok: false,
        code: made > expected ? "RETRIED" : "REQUESTS",
        message: `${made} HTTP request(s) where the call makes ${expected}${made > expected ? ": a request failed and was retried inside the call" : ""}`,
        requests: made,
      };
    return { ok: true, value, ms, requests: made };
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return {
      ok: false,
      code: typeof code === "string" ? code : e instanceof Error ? e.name : "Error",
      message: (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 240),
      requests: requests.count - before,
    };
  }
};
