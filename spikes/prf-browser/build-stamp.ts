// The build stamp the page shows and "Copy result" reports: the last commit that changed anything the page is
// built from, plus "+dirty" when any of those inputs has uncommitted changes (untracked files included). Commits
// elsewhere in the repo (contracts, docs) leave the stamp unchanged, so one stamp names one page.
import { execFileSync } from "node:child_process";

/**
 * Git pathspecs relative to spikes/prf-browser: the page itself, the SDK it bundles, and the lockfile that pins
 * every dependency version. Markdown and tests never enter the bundle. `top` makes the Markdown exclusion
 * repo-wide: a plain `:(exclude)*.md` is relative to this folder and would still count an SDK README.
 */
export const PAGE_INPUTS = [
  ".", "../../packages/letterlock", "../../pnpm-lock.yaml",
  ":(top,exclude)*.md",
  ":(exclude)test", ":(exclude)*.mjs", // this folder's unit tests and test scripts (check-page, run-spike)
  ":(top,exclude)packages/letterlock/test",
] as const;

export const buildStamp = (dir: string): string => {
  // no shell: the pathspec magic must reach git unquoted and intact
  const git = (...args: string[]) => {
    try { return execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; }
  };
  const commit = git("log", "-1", "--format=%h", "--", ...PAGE_INPUTS) || "nogit";
  return commit + (git("status", "--porcelain", "--", ...PAGE_INPUTS) ? "+dirty" : "");
};
