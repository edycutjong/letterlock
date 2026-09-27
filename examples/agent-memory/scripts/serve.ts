#!/usr/bin/env node
// The agent on node:http, configured from the environment (see README): public/ as static files, and /remember,
// /task and /health to the agent. With --bundle it runs the built Vercel function (run `node scripts/build.mjs`
// first), the same file production runs; without it, the TypeScript source.
//
//   AGENT_ENABLED=true LETTERLOCK_CHAIN=monad-testnet ... node scripts/serve.ts [--port 8787] [--bundle]
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");
const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** The agent's request handler: the built bundle, or the source. Reads process.env when loaded. */
export const loadHandler = async (bundle: boolean): Promise<Handler> => {
  if (bundle) {
    const file = join(root, ".vercel", "output", "functions", "api", "agent.func", "index.mjs");
    return ((await import(pathToFileURL(file).href)) as { default: Handler }).default;
  }
  const { createAppFromEnv } = await import("../src/app.ts");
  const { nodeHandler } = await import("../src/node.ts");
  return nodeHandler(createAppFromEnv(process.env), { trustProxy: false });
};

export const serve = (handler: Handler, port: number): Promise<Server> =>
  new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (/^\/(remember|task|health)\/?$/.test(path)) return void handler(req, res);
      const file = normalize(join(root, "public", path === "/" ? "index.html" : path));
      if (!file.startsWith(join(root, "public"))) return void res.writeHead(404).end();
      readFile(file).then(
        (body) => res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body),
        () => res.writeHead(404, { "content-type": "text/plain" }).end("not found\n"),
      );
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--port");
  const port = at >= 0 ? Number(args[at + 1]) : 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be a port number");
  const server = await serve(await loadHandler(args.includes("--bundle")), port);
  const address = server.address();
  console.log(`agent on http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`);
}
