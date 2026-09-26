// Where a script may write a secret: only outside the repository, where `git add -A` cannot pick it up. smoke.mjs
// writes its PRF stand-in, which opens anything sealed to its key, to --out through this check.
//
// A path is compared as the file system resolves it: symlinks followed and letter case as stored, on the nearest part
// of the path that exists (the rest does not exist yet, so it holds no link), and then by whole path segments. So a
// folder inside the repository named like "..keys", a link into the tree and the repository's path typed in another
// letter case (on a file system that ignores case) all count as inside.
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

/** True when `path` is neither `dir` nor anything inside it. */
export const isOutside = (dir, path) => {
  const rel = relative(physicalPath(dir), physicalPath(path));
  return isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`);
};
