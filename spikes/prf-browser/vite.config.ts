import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const git = (...args: string[]) => {
  try { return execFileSync("git", args, { cwd: here, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; }
};
// The page shows (and "Copy result" reports) which commit it was built from; "+dirty" = uncommitted spike edits
// (Markdown excluded: docs never enter the bundle).
const build = `${git("rev-parse", "--short", "HEAD") || "nogit"}${git("status", "--porcelain", "--", ".", ":(exclude)*.md") ? "+dirty" : ""}`;

export default defineConfig({
  define: { __LL_BUILD__: JSON.stringify(build) },
  build: { outDir: "dist", emptyOutDir: true },
  preview: { port: 4178, strictPort: true },
});
