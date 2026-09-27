// Turns dist/ (tsup's output) into the npm package: writes dist/package.json from ../package.json, and copies
// README.md, CHANGELOG.md and LICENSE. Publish with `npm publish ./dist` from packages/letterlock: a folder, never a
// .tgz, since npm records a tarball's local path in the published manifest (_resolved, _from). The workspace manifest
// itself is private (its exports point at the TypeScript sources the other workspace packages compile), so publishing
// it by mistake is refused.
import { copyFileSync, readFileSync, statSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
for (const f of ["dist/index.js", "dist/index.d.ts", "dist/cli.js"]) statSync(f); // run tsup first

const manifest = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  keywords: pkg.keywords,
  license: pkg.license,
  repository: pkg.repository,
  homepage: pkg.homepage,
  bugs: pkg.bugs,
  type: "module",
  sideEffects: false,
  engines: pkg.engines,
  exports: {
    ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" },
    "./package.json": "./package.json",
  },
  main: "./index.js",
  types: "./index.d.ts",
  bin: { letterlock: "./cli.js" },
  files: ["*.js", "index.d.ts", "README.md", "CHANGELOG.md", "LICENSE"],
  dependencies: pkg.dependencies,
};
writeFileSync("dist/package.json", `${JSON.stringify(manifest, null, 2)}\n`);
copyFileSync("README.md", "dist/README.md");
copyFileSync("CHANGELOG.md", "dist/CHANGELOG.md");
copyFileSync("LICENSE", "dist/LICENSE");
console.log(`staged ${manifest.name}@${manifest.version} in dist/`);
