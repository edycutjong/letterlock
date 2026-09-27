// A JSON-RPC proxy in front of the anvil chain that behaves like one of Monad's public RPCs: it can refuse JSON-RPC
// batches with HTTP 403 (rpc-mainnet.monadinfra.com answers any batch, even a batch of one, with 403 "Restricted JSON
// RPC method"), and it can answer chosen requests itself (a range refusal, an error in a node's own words).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type RpcRequest = { readonly jsonrpc: "2.0"; readonly id: unknown; readonly method: string; readonly params: unknown[] };
export type RpcReply = { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };

/** Answer a request in place of anvil (return the reply), or return undefined to forward it. `upstream()` forwards it now. */
export type Intercept = (req: RpcRequest, upstream: () => Promise<RpcReply>) => Promise<RpcReply | undefined> | RpcReply | undefined;

export type ProxyOptions = { readonly refuseBatches?: boolean; readonly intercept?: Intercept };

export const rpcError = (req: RpcRequest, code: number, message: string): RpcReply => ({ jsonrpc: "2.0", id: req.id, error: { code, message } });

export const rpcProxy = async (upstreamUrl: string, o: ProxyOptions = {}) => {
  const stats = { requests: 0, batches: 0, methods: {} as Record<string, number> };
  const forward = async (req: RpcRequest): Promise<RpcReply> => {
    const r = await fetch(upstreamUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
    return (await r.json()) as RpcReply;
  };
  const answer = async (req: RpcRequest): Promise<RpcReply> => {
    stats.requests++;
    stats.methods[req.method] = (stats.methods[req.method] ?? 0) + 1;
    return (await o.intercept?.(req, () => forward(req))) ?? forward(req);
  };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      void (async () => {
        const parsed = JSON.parse(body) as RpcRequest | RpcRequest[];
        if (Array.isArray(parsed)) {
          stats.batches++;
          if (o.refuseBatches) {
            res.writeHead(403, { "content-type": "text/plain" });
            res.end("Restricted JSON RPC method");
            return;
          }
        }
        const reply = Array.isArray(parsed) ? await Promise.all(parsed.map(answer)) : await answer(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply));
      })().catch((e: unknown) => { res.writeHead(500); res.end(String(e)); });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stats,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
};
