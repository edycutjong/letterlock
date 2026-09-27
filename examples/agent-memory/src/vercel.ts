// The Vercel function's entry (bundled by scripts/build.mjs into .vercel/output/functions/api/agent.func): one
// Node.js function behind /remember, /task and /health, so its in-memory limits see every route.
import { createAppFromEnv } from "./app.ts";
import { nodeHandler } from "./node.ts";

export default nodeHandler(createAppFromEnv(process.env), { trustProxy: true });
