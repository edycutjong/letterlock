import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { buildStamp } from "./build-stamp.ts";

// The page shows (and "Copy result" reports) which commit it was built from: the last commit that changed the page,
// the SDK it bundles or the lockfile, plus "+dirty" for uncommitted edits to any of them (see build-stamp.ts).
const build = buildStamp(fileURLToPath(new URL(".", import.meta.url)));

export default defineConfig({
  define: { __LL_BUILD__: JSON.stringify(build) },
  build: { outDir: "dist", emptyOutDir: true },
  preview: { port: 4178, strictPort: true },
});
