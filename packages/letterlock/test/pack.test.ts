// The npm package as it would be published: `npm run build` (tsup, then scripts/stage.mjs writes dist/package.json),
// `npm pack ./dist --dry-run`, the bin run as a child process, and the library bundled for a browser with esbuild.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/index.ts";
import { anvil, client, fundedAccount, noChain, standIn } from "./anvil/context.ts";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const dist = (f: string) => fileURLToPath(new URL(`../dist/${f}`, import.meta.url));
const run = promisify(execFile);

/**
 * Bytes each package contributes to a minified browser bundle of `source` (esbuild fails on a Node built-in). Any
 * warning fails too: esbuild only warns about, for example, an import that will always be undefined.
 */
const browserBundle = async (source: string) => {
  const r = await build({
    stdin: { contents: source, resolveDir: pkgDir, loader: "js" },
    bundle: true, platform: "browser", format: "esm", write: false, metafile: true, minify: true, logLevel: "silent",
  });
  expect(r.warnings.map((w) => `${w.text} (${w.location?.file ?? "?"})`), "esbuild warnings").toEqual([]);
  const bytes: Record<string, number> = {};
  for (const [file, v] of Object.entries(Object.values(r.metafile.outputs)[0]!.inputs)) {
    if (!v.bytesInOutput) continue;
    const m = /node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(file);
    const name = m ? m[1]! : file.startsWith("dist/") ? "letterlock" : file;
    bytes[name] = (bytes[name] ?? 0) + v.bytesInOutput;
  }
  return bytes;
};

describe("npm package", () => {
  beforeAll(() => { execFileSync("npm", ["run", "build"], { cwd: pkgDir, stdio: "pipe" }); }, 180_000);

  it("npm pack --dry-run holds only the build, README.md, CHANGELOG.md, LICENSE and package.json", () => {
    const out = execFileSync("npm", ["pack", "./dist", "--dry-run", "--json"], { cwd: pkgDir, stdio: ["ignore", "pipe", "pipe"] }).toString();
    const [info] = JSON.parse(out) as { name: string; version: string; files: { path: string }[] }[];
    const files = info!.files.map((f) => f.path).sort();
    expect([info!.name, info!.version]).toEqual(["letterlock", VERSION]);
    expect(files.filter((f) => !/^chunk-[A-Z0-9]+\.js$/.test(f))).toEqual(["CHANGELOG.md", "LICENSE", "README.md", "cli.js", "index.d.ts", "index.js", "package.json"]);
  });

  it("no packed file carries a source map, a test, or the name of a private planning note", () => {
    const planning = fileURLToPath(new URL("../../../../specs/", import.meta.url));
    const names = existsSync(planning) ? readdirSync(planning).filter((f) => f.endsWith(".md") && f !== "README.md") : [];
    for (const f of readdirSync(dist(""))) {
      const text = readFileSync(dist(f), "utf8");
      expect(text.includes("sourceMappingURL"), f).toBe(false);
      expect(/soft-authenticator|vitest|global-setup/.test(text), f).toBe(false);
      for (const n of names) expect(text.includes(n), `${f} names a planning note`).toBe(false);
    }
  });

  it("the manifest: ESM exports with types, the bin, engines, MIT, the repository; nothing workspace-only", () => {
    const m = JSON.parse(readFileSync(dist("package.json"), "utf8")) as Record<string, unknown>;
    expect(m).toMatchObject({
      name: "letterlock", version: VERSION, license: "MIT", type: "module", sideEffects: false,
      exports: { ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" } },
      bin: { letterlock: "./cli.js" }, engines: { node: ">=20.19.0" },
      repository: { type: "git", url: expect.stringMatching(/^git\+https:\/\/github\.com\//), directory: "packages/letterlock" },
    });
    for (const k of ["private", "scripts", "devDependencies"]) expect(m, k).not.toHaveProperty(k);
    // npm's install-time fields (_resolved, _from, _integrity...) name a local path when a tarball is published: none here
    expect(Object.keys(m).filter((k) => k.startsWith("_"))).toEqual([]);
    expect(JSON.stringify(m.dependencies)).not.toContain("workspace:");
    expect(readFileSync(dist("cli.js"), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("the bin prints the version", async () => {
    expect((await run(process.execPath, [dist("cli.js"), "--version"])).stdout).toBe(`${VERSION}\n`);
  });

  it.skipIf(noChain)("the bin resolves a key on the anvil directory", async () => {
    const account = await fundedAccount();
    const keys = standIn(101, 1);
    await client().publish({ account, keys });
    const { stdout } = await run(process.execPath, [dist("cli.js"), "resolve", account.address, "--json", "--rpc", anvil().rpcUrl, "--directory", anvil().directory]);
    expect(JSON.parse(stdout)).toMatchObject({ recipient: account.address.toLowerCase(), epoch: 1, chainId: 143 });
  });

  it("the library bundles for a browser: no Node built-in anywhere, and imports shake", async () => {
    const all = await browserBundle(`import * as L from "./dist/index.js"; console.log(L);`);
    expect(all.commander).toBeUndefined();
    const sealOnly = await browserBundle(`import { seal, open } from "./dist/index.js"; console.log(seal, open);`);
    for (const heavy of ["viem", "ox", "@category-labs/mera", "@scure/bip39", "commander"]) expect(sealOnly[heavy], heavy).toBeUndefined();
    const clientOnly = await browserBundle(`import { letterlock } from "./dist/index.js"; console.log(letterlock);`);
    expect(clientOnly.viem).toBeGreaterThan(0);
    expect(clientOnly["@scure/bip39"]).toBeUndefined(); // meraAccount not imported, so no BIP-39 wordlist
  });
});
