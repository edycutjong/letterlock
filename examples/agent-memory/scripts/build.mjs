#!/usr/bin/env node
// Builds the Vercel deployment as a Build Output API v3 directory, .vercel/output, which `vercel deploy --prebuilt`
// uploads as it is: nothing is installed or built on Vercel. The function is one ESM file bundled here from
// src/vercel.ts (the agent, the letterlock SDK from this workspace, viem and noble); public/ is copied as the static
// site; config.json routes /remember, /task and /health to the function and serves the rest as files.
//
//   node scripts/build.mjs          → .vercel/output
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".vercel", "output");
const func = join(out, "functions", "api", "agent.func");

rmSync(out, { recursive: true, force: true });
mkdirSync(func, { recursive: true });

await build({
  entryPoints: [join(root, "src", "vercel.ts")],
  outfile: join(func, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // some bundled CommonJS reaches for require(); give the ESM bundle one
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  legalComments: "none",
  logLevel: "warning",
});
writeFileSync(join(func, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
writeFileSync(
  join(func, ".vc-config.json"),
  `${JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, maxDuration: 60 }, null, 2)}\n`,
);

cpSync(join(root, "public"), join(out, "static"), { recursive: true });

const config = {
  version: 3,
  routes: [
    {
      src: "^/\\.well-known/(.*)$",
      headers: {
        "access-control-allow-origin": "*",
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=0, must-revalidate",
      },
      continue: true,
    },
    { src: "^/(remember|task|health)/?$", dest: "/api/agent?route=$1" },
    { handle: "filesystem" },
  ],
};
writeFileSync(join(out, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

const kb = (p) => `${(statSync(p).size / 1024).toFixed(0)} KiB`;
console.log(`built ${out}\n  functions/api/agent.func/index.mjs  ${kb(join(func, "index.mjs"))}\n  static/  (public/)`);
