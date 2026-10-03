// Semantic versions for the SDK, from Conventional Commits. The npm package is what the repository versions: the
// app, the agent and the site deploy continuously from main, and the contract is immutable on chain. A release tag
// vX.Y.Z, the GitHub Release, letterlock@X.Y.Z on npm and every version stamp on the site name the same version.
//
//   node scripts/release.ts plan             JSON: the last tag, the SDK commits since, the bump and the next version
//   node scripts/release.ts apply <x.y.z>    write the version to package.json and src/version.ts, add a CHANGELOG
//                                            section, and stamp every surface (scripts/version-sync.ts)
//   node scripts/release.ts notes <x.y.z>    the CHANGELOG section of that version (the GitHub Release's body)
//
// Only commits that change what the SDK runs count: its source, or the runtime fields of its manifest (a
// devDependency or a test does not). Bumps: below 1.0.0, a breaking change (`type!:` or a `BREAKING CHANGE:` footer)
// or a feat is minor and a fix or perf is patch; from 1.0.0, breaking is major. 1.0.0 itself is a decision, made by
// running apply by hand. docs, test, chore, ci, build, style and refactor commits release nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, SDK_RUNTIME_PATHS, SDK_VERSION_FILE, manifestRuntime, tryGit } from "./lib/git.ts";
import { sync } from "./version-sync.ts";

const PKG = "packages/letterlock/package.json";
const CHANGELOG = "packages/letterlock/CHANGELOG.md";
const REPO = "https://github.com/edycutjong/letterlock";

export type Bump = "major" | "minor" | "patch";
export type Commit = { readonly sha: string; readonly subject: string; readonly body: string };

const HEADER = /^(\w+)(\([^)]*\))?(!)?:\s/;

/** The bump one commit asks for, or undefined for a commit that releases nothing. */
export const bumpOf = (c: Commit): Bump | undefined => {
  if (/^chore\(release\)/.test(c.subject)) return undefined;
  const m = HEADER.exec(c.subject);
  if (!m) return undefined;
  if (m[3] || /^BREAKING[ -]CHANGE:/m.test(c.body)) return "major";
  if (m[1] === "feat") return "minor";
  if (m[1] === "fix" || m[1] === "perf") return "patch";
  return undefined;
};

const RANK: Record<Bump, number> = { patch: 1, minor: 2, major: 3 };

/** The next version after `current` for these commits; undefined when none of them releases. */
export const nextVersion = (current: string, commits: readonly Commit[]): { bump: Bump; next: string } | undefined => {
  let bump: Bump | undefined;
  for (const c of commits) {
    const b = bumpOf(c);
    if (b && (!bump || RANK[b] > RANK[bump])) bump = b;
  }
  if (!bump) return undefined;
  const [maj, min, pat] = current.split(".").map(Number) as [number, number, number];
  const pre1 = maj === 0;
  const eff: Bump = pre1 && bump === "major" ? "minor" : bump;
  const next = eff === "major" ? `${maj + 1}.0.0` : eff === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
  return { bump: eff, next };
};

/** Commits since `since` that change what the SDK runs, oldest first. */
export const sdkCommits = (since: string | undefined): Commit[] => {
  const range = since ? [`${since}..HEAD`] : ["HEAD"];
  const log = tryGit("log", "--reverse", "--format=%H%x1f%s%x1f%b%x1e", ...range, "--", SDK_RUNTIME_PATHS[0], SDK_RUNTIME_PATHS[1], `:(exclude)${SDK_VERSION_FILE}`);
  const out: Commit[] = [];
  for (const rec of log.split("\x1e").map((r) => r.trim()).filter(Boolean)) {
    const [sha, subject, body] = rec.split("\x1f") as [string, string, string?];
    const files = tryGit("diff-tree", "--no-commit-id", "--name-only", "-r", sha).split("\n");
    const src = files.some((f) => f.startsWith(`${SDK_RUNTIME_PATHS[0]}/`) && f !== SDK_VERSION_FILE);
    const parent = tryGit("rev-parse", "-q", "--verify", `${sha}^`);
    const manifest = files.includes(PKG) && (!parent || manifestRuntime(sha) !== manifestRuntime(parent));
    if (src || manifest) out.push({ sha, subject, body: body ?? "" });
  }
  return out;
};

export const plan = () => {
  const last = tryGit("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*") || undefined;
  const current = (JSON.parse(readFileSync(join(ROOT, PKG), "utf8")) as { version: string }).version;
  const commits = sdkCommits(last);
  const n = nextVersion(current, commits);
  return { last, current, commits: commits.map((c) => `${c.sha.slice(0, 7)} ${c.subject}`), bump: n?.bump ?? null, next: n?.next ?? null };
};

/** The CHANGELOG section for a release: one line per commit, by kind. */
export const section = (version: string, date: string, commits: readonly Commit[]): string => {
  const kinds: [string, (c: Commit) => boolean][] = [
    ["Breaking", (c) => bumpOf(c) === "major"],
    ["Features", (c) => bumpOf(c) === "minor"],
    ["Fixes", (c) => bumpOf(c) === "patch"],
  ];
  const lines = [`## ${version} (${date})`, ""];
  for (const [title, pick] of kinds) {
    const cs = commits.filter(pick);
    if (!cs.length) continue;
    lines.push(`**${title}**`, "");
    for (const c of cs) lines.push(`- ${c.subject.replace(HEADER, "")} ([${c.sha.slice(0, 7)}](${REPO}/commit/${c.sha}))`);
    lines.push("");
  }
  return lines.join("\n");
};

export const apply = (version: string) => {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version}`);
  const pkgPath = join(ROOT, PKG);
  const pkg = readFileSync(pkgPath, "utf8");
  writeFileSync(pkgPath, pkg.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
  const vf = join(ROOT, SDK_VERSION_FILE);
  writeFileSync(vf, readFileSync(vf, "utf8").replace(/(VERSION = ")[^"]+(")/, `$1${version}$2`));
  const last = tryGit("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*") || undefined;
  const cl = join(ROOT, CHANGELOG);
  const text = readFileSync(cl, "utf8");
  const sec = section(version, new Date().toISOString().slice(0, 10), sdkCommits(last));
  writeFileSync(cl, text.replace(/^# Changelog\n\n/, `# Changelog\n\n${sec}\n`));
  const problems = sync(false);
  if (problems.length) throw new Error(problems.join("\n"));
};

/** The body of the CHANGELOG section for `version`, without its heading. */
export const notes = (version: string, changelog = readFileSync(join(ROOT, CHANGELOG), "utf8")): string => {
  const parts = changelog.split(/^## /m);
  const part = parts.find((p) => p.startsWith(`${version} `));
  if (!part) throw new Error(`no CHANGELOG section for ${version}`);
  return part.split("\n").slice(1).join("\n").trim();
};

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "plan") console.log(JSON.stringify(plan(), null, 2));
  else if (cmd === "apply" && arg) apply(arg);
  else if (cmd === "notes" && arg) console.log(notes(arg));
  else {
    console.error("usage: node scripts/release.ts plan | apply <x.y.z> | notes <x.y.z>");
    process.exit(2);
  }
}
