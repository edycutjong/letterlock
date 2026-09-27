// What a result was measured against: the checked-out commit, and the last commit that changed the SDK's runtime code.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The SDK's runtime code: its source and its manifest (dependencies). Test-only and docs-only commits change no number
 * a benchmark measures, so they do not make one stale. scripts/check_submission_readiness.py uses the same paths.
 */
export const SDK_RUNTIME_PATHS = ["packages/letterlock/src", "packages/letterlock/package.json"] as const;

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

export type GitContext = {
  readonly head: string;
  /** The last commit that changed SDK_RUNTIME_PATHS, and its committer date (ISO 8601). */
  readonly sdkCommit: string;
  readonly sdkCommitDate: string;
  /** Uncommitted changes under SDK_RUNTIME_PATHS when measured: the numbers then belong to no commit. */
  readonly sdkDirty: boolean;
};

/** Undefined outside a git checkout (a tarball of the repository). */
export const gitContext = (): GitContext | undefined => {
  try {
    const [sdkCommit, sdkCommitDate] = git("log", "-1", "--format=%H%n%cI", "--", ...SDK_RUNTIME_PATHS).split("\n");
    return {
      head: git("rev-parse", "HEAD"),
      sdkCommit: sdkCommit!,
      sdkCommitDate: sdkCommitDate!,
      sdkDirty: git("status", "--porcelain", "--", ...SDK_RUNTIME_PATHS) !== "",
    };
  } catch {
    return undefined;
  }
};
