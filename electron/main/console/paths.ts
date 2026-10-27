// The Console's file scope (docs/CONSOLE.md): read anywhere the user can read; write and delete only inside the folders
// the user chose (the results folder, the cache folder, each queued clip's results folder). A path is resolved with
// realpath before any check (symlinks and `..` resolved; a path that doesn't exist yet resolves through its nearest
// existing parent), and the resolved path is what the command is then given, so what was checked is what is used.
// The platform is a parameter so Windows' rules (case-insensitive, backslashes, drive letters) are tested on Linux.
import { realpath as fsRealpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { PLATFORM } from "../platform";

export interface PathDeps {
  realpath: (p: string) => Promise<string>;
  platform: NodeJS.Platform;
  home: string;
}

export const realPathDeps = (home: string): PathDeps => ({ realpath: (p) => fsRealpath(p), platform: PLATFORM, home });

const api = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);
/** Windows and macOS (APFS's default) compare names without case. */
const foldsCase = (platform: NodeJS.Platform) => platform === "win32" || platform === "darwin";

/** `~` and `~/…` (`~\…` on Windows) are the home folder; nothing else is expanded. */
export function expandHome(p: string, d: Pick<PathDeps, "home" | "platform">): string {
  if (p === "~") return d.home;
  if (p.startsWith("~/") || (d.platform === "win32" && p.startsWith("~\\"))) return api(d.platform).join(d.home, p.slice(2));
  return p;
}

/** The absolute, symlink-free path `p` (relative to `cwd`) names; a missing tail is kept as typed below its real parent. */
export async function resolveReal(p: string, cwd: string, d: PathDeps): Promise<string> {
  const a = api(d.platform);
  const abs = a.resolve(cwd, expandHome(p, d));
  const tail: string[] = [];
  let cur = abs;
  // loop: NOT-WORTH — one async realpath per missing path level [bounded: the path's depth]
  for (;;) {
    try {
      return a.join(await d.realpath(cur), ...tail.reverse());
    } catch (e) {
      // error: SHOWN — only "not there (yet)" walks up; anything else (no permission) is the caller's refusal
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      const parent = a.dirname(cur);
      if (parent === cur) return abs;
      tail.push(a.basename(cur));
      cur = parent;
    }
  }
}

/** Whether `child` is `root` or inside it (both absolute and resolved). */
export function isInside(child: string, root: string, platform: NodeJS.Platform): boolean {
  const a = api(platform);
  const fold = (s: string) => (foldsCase(platform) ? s.toLowerCase() : s);
  const rel = a.relative(fold(a.normalize(root)), fold(a.normalize(child)));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + a.sep) && !a.isAbsolute(rel));
}

export type WriteCheck = { ok: true; path: string } | { ok: false; path: string; reason: string };

/** May the Console write (or delete) at `p`? Yes only inside one of `roots` (each resolved too). */
export async function checkWrite(p: string, cwd: string, roots: readonly string[], d: PathDeps): Promise<WriteCheck> {
  let path: string;
  try {
    path = await resolveReal(p, cwd, d);
  } catch (e) {
    // error: SHOWN — the refusal says why the path couldn't be resolved
    return { ok: false, path: p, reason: `${p} can't be checked: ${(e as Error).message}` };
  }
  const real: string[] = [];
  // loop: NOT-WORTH — a few chosen folders (the queue's clips), one async realpath each, per write checked
  for (const r of roots) real.push(await resolveReal(r, r, d).catch(() => r));
  // loop: NOT-WORTH — as above
  if (real.some((r) => isInside(path, r, d.platform))) return { ok: true, path };
  return {
    ok: false,
    path,
    reason: roots.length
      ? `${path} is outside the folders the Console may write to: ${[...new Set(real)].join(", ")} (the results folder, the cache folder, the queued clips' results folders)`
      : `${path}: the Console writes only into chosen folders, and none is chosen yet (choose a results folder in App settings, or add the clip to the queue)`,
  };
}
