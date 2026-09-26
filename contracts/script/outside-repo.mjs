// Where a script may write a secret: only outside the repository, where `git add -A` cannot pick it up. smoke.mjs
// writes its PRF stand-in, which opens anything sealed to its key, to --out through this check.
//
// Inside or outside is decided by file identity, not by path text: the path is resolved (symlinks followed) as far as
// it exists, and it is inside when that folder or any folder above it has the repository root's device and inode. So
// every spelling of the tree is inside: a folder in it named like "..keys", a link into it, the repository's path in
// another letter case (on a file system that ignores case), in another Unicode normalisation, through a bind mount,
// or through a second name for the same folder such as macOS's /System/Volumes/Data/Users/... firmlink.
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** `path` as the file system resolves it. Throws on a symlink that does not resolve (dangling, or a loop). */
export const physicalPath = (path) => {
  const abs = resolve(path);
  if (existsSync(abs)) return realpathSync.native(abs);
  let link = false;
  try {
    link = lstatSync(abs).isSymbolicLink();
  } catch {
    // nothing at abs: resolve its parent
  }
  if (link) throw new Error(`${abs} is a symlink that does not resolve`);
  const parent = dirname(abs);
  return parent === abs ? abs : join(physicalPath(parent), basename(abs));
};

const identity = (path) => {
  const s = statSync(path, { bigint: true });
  return `${s.dev}:${s.ino}`;
};

/** True when `path` is neither `dir` nor anything inside it, compared by (device, inode) of `dir` and each ancestor. */
export const isOutside = (dir, path) => {
  const root = identity(dir);
  let p = physicalPath(path);
  while (!existsSync(p)) p = dirname(p); // the part that does not exist yet holds no link and no second name
  for (;;) {
    if (identity(p) === root) return false;
    const parent = dirname(p);
    if (parent === p) return true;
    p = parent;
  }
};
