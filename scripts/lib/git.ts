// What a result was measured against: the checked-out commit, the last commit that changed the SDK's runtime code, and
// whether the benchmark's own code was committed when it ran.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The SDK's runtime code: its source and its manifest's runtime fields (SDK_RUNTIME_FIELDS). Test-only and docs-only commits change no number
 * a benchmark measures, so they do not make one stale. scripts/check_submission_readiness.py uses the same paths.
 */
export const SDK_RUNTIME_PATHS = ["packages/letterlock/src", "packages/letterlock/package.json"] as const;

/** The manifest's fields that change what runs; a devDependency, script or version-only edit does not. */
export const SDK_RUNTIME_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies", "exports", "type", "engines"] as const;
const SDK_MANIFEST = SDK_RUNTIME_PATHS[1];

/** The version string alone: a release commit changes it and nothing a benchmark measures. */
export const SDK_VERSION_FILE = "packages/letterlock/src/version.ts";

/** The benchmark's own code: what it times and how it reports it. */
export const BENCH_PATHS = ["scripts/bench.ts", "scripts/lib"] as const;

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

export const tryGit = (...args: string[]): string => {
  try {
    return git(...args);
  } catch {
    return "";
  }
};

export const manifestRuntime = (sha: string): string | undefined => {
  const text = tryGit("show", `${sha}:${SDK_MANIFEST}`);
  if (!text) return undefined;
  try {
    const m = JSON.parse(text) as Record<string, unknown>;
    return JSON.stringify(Object.fromEntries([...SDK_RUNTIME_FIELDS].sort().map((k) => [k, m[k] ?? null])));
  } catch {
    return text;
  }
};

/** The last commit that changed the SDK's source or its manifest's runtime fields: "<sha>\n<committer date>". */
const lastSdkRuntimeCommit = (): string => {
  const candidates: string[] = [];
  const src = git("log", "-1", "--format=%H", "--", SDK_RUNTIME_PATHS[0], `:(exclude)${SDK_VERSION_FILE}`);
  if (src) candidates.push(src);
  for (const sha of git("log", "--format=%H", "--", SDK_MANIFEST).split("\n").filter(Boolean)) {
    const parent = tryGit("rev-parse", "-q", "--verify", `${sha}^`);
    if (!parent || manifestRuntime(sha) !== manifestRuntime(parent)) {
      candidates.push(sha);
      break;
    }
  }
  // the later of the two: a candidate that is not an ancestor of the newest so far came after it
  const newest = candidates.reduce((a, c) => (tryGit("rev-list", "-1", `${a}..${c}`) ? c : a));
  return git("log", "-1", "--format=%H%n%cI", newest);
};

export type GitContext = {
  readonly head: string;
  /** The last commit that changed SDK_RUNTIME_PATHS, and its committer date (ISO 8601). */
  readonly sdkCommit: string;
  readonly sdkCommitDate: string;
  /** Uncommitted changes under SDK_RUNTIME_PATHS when measured: the numbers then belong to no commit. */
  readonly sdkDirty: boolean;
  /** The last commit that changed BENCH_PATHS, and whether they had uncommitted changes when the bench ran. */
  readonly benchCommit: string;
  readonly benchDirty: boolean;
};

/** Undefined outside a git checkout (a tarball of the repository). */
export const gitContext = (): GitContext | undefined => {
  try {
    const [sdkCommit, sdkCommitDate] = lastSdkRuntimeCommit().split("\n");
    return {
      head: git("rev-parse", "HEAD"),
      sdkCommit: sdkCommit!,
      sdkCommitDate: sdkCommitDate!,
      sdkDirty: git("status", "--porcelain", "--", ...SDK_RUNTIME_PATHS) !== "",
      benchCommit: git("log", "-1", "--format=%H", "--", ...BENCH_PATHS),
      benchDirty: git("status", "--porcelain", "--", ...BENCH_PATHS) !== "",
    };
  } catch {
    return undefined;
  }
};
