// node:http (req, res) around the web-standard app: what a Vercel Node.js function and the local server both run.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { App } from "./app.ts";

export type NodeHandlerOptions = {
  /**
   * Take the client's IP from x-real-ip / x-forwarded-for. Only behind a proxy that sets them (Vercel overwrites both
   * with the address it saw); anywhere else a client could pick its own rate-limit key.
   */
  readonly trustProxy: boolean;
};

export const clientIp = (req: IncomingMessage, trustProxy: boolean): string => {
  if (trustProxy) {
    const real = req.headers["x-real-ip"];
    if (typeof real === "string" && real) return real.trim();
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
};

export const nodeHandler = (app: App, o: NodeHandlerOptions) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  try {
    const url = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const v of value) headers.append(name, v);
      else if (value !== undefined) headers.set(name, value);
    }
    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const request = new Request(url, {
      method,
      headers,
      ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
    } as RequestInit);
    const response = await app(request, clientIp(req, o.trustProxy));
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.end(method === "HEAD" || response.body === null ? undefined : Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
    }
    res.end('{ "error": { "code": "INTERNAL", "message": "the agent failed unexpectedly" } }\n');
  }
};
