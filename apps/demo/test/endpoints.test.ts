// The endpoints the middleware's policy allows are the ones the pages use: the SDK's RPC for the chain, the scan RPC,
// the reference agent and the Sourcify record. A page that fetched anywhere else would be blocked by its own policy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
  load: (url, context, nextLoad) =>
    url.startsWith("file:") && url.endsWith(".json")
      ? { format: "module", source: `export default ${readFileSync(new URL(url), "utf8")};`, shortCircuit: true }
      : nextLoad(url, context),
});

const { DEPLOYMENTS } = await import("letterlock");
const { CHAIN_NAME, RPC_URL, SCAN_RPC_URL, AGENT_URL, SOURCE_CHECK_URL } = await import("../lib/endpoints.ts");
const { CONNECT_SOURCES, contentSecurityPolicy } = await import("../lib/csp.ts");

test("the RPC is the SDK's own for the chain", () => {
  assert.equal(RPC_URL, DEPLOYMENTS[CHAIN_NAME].rpcUrl);
});

test("the policy lets the page reach exactly its RPCs, the agent and Sourcify", () => {
  const want = [RPC_URL, SCAN_RPC_URL, AGENT_URL, SOURCE_CHECK_URL].filter(Boolean).map((u) => new URL(u!).origin);
  assert.deepEqual([...CONNECT_SOURCES].sort(), [...new Set(want)].sort());
  if (CHAIN_NAME === "monad") {
    assert.deepEqual([...CONNECT_SOURCES].sort(), [
      "https://letterlock-agent.vercel.app",
      "https://rpc.monad.xyz",
      "https://rpc1.monad.xyz",
      "https://sourcify-api-monad.blockvision.org",
    ]);
  }
});

test("scripts run only with the request's nonce; no eval, frames, plugins or foreign forms in production", () => {
  const csp = contentSecurityPolicy("abc123", { dev: false, https: true });
  assert.match(csp, /script-src 'self' 'nonce-abc123' 'strict-dynamic'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  for (const d of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'", "upgrade-insecure-requests"]) assert.ok(csp.includes(d), d);
  // plain http (the local end-to-end build) is not upgraded, or its own files would be asked for over https
  assert.doesNotMatch(contentSecurityPolicy("x", { dev: false, https: false }), /upgrade-insecure-requests/);
});
