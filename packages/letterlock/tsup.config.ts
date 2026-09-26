import { defineConfig } from "tsup";

// Two entries: the library (ESM + one bundled index.d.ts) and the `letterlock` bin. Dependencies stay external, so an
// app's bundler tree-shakes the library as usual; nothing Node-only is reachable from the library entry.
// scripts/stage.mjs then writes dist/package.json, README.md and LICENSE: dist/ is the npm package.
export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: ["esm"],
  target: "es2022",
  platform: "node",
  dts: { entry: { index: "src/index.ts" } },
  splitting: true,
  treeshake: true,
  sourcemap: false,
  clean: true,
  outDir: "dist",
});
