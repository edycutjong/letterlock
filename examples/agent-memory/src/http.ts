// Small HTTP helpers on the web-standard Request and Response, so the same handlers run on Vercel, in node:http and in
// tests.

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, code: string, message: string, headers: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const CORS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

const BASE: Readonly<Record<string, string>> = {
  ...CORS,
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/** JSON with bigints as decimal strings. */
export const json = (status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): Response =>
  new Response(`${JSON.stringify(body, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`, {
    status,
    headers: { ...BASE, ...headers },
  });

export const failure = (status: number, code: string, message: string, headers: Readonly<Record<string, string>> = {}): Response =>
  json(status, { error: { code, message } }, headers);

/**
 * The request body as JSON: application/json only, at most `maxBytes` (checked on the declared length and again on the
 * bytes read, so a body without a length cannot run past it), UTF-8.
 */
export const readJson = async (request: Request, maxBytes: number): Promise<unknown> => {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "send the body as application/json");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "BODY_TOO_LARGE", `the body is ${declared} bytes; the agent reads at most ${maxBytes}`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, "BODY_TOO_LARGE", `the body is over ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new HttpError(400, "INPUT_INVALID", "the body is not UTF-8 JSON");
  }
};
