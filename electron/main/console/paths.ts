// The Console's file scope (docs/CONSOLE.md): read anywhere the user can read; write and delete only inside the folders
// the user chose (the results folder, the cache folder, each queued clip's results folder, the folders allowed with
// `allow`). A path is resolved with
// realpath before any check (symlinks and `..` resolved; a path that doesn't exist yet resolves through its nearest
// existing parent), and the resolved path is what the command is then given, so what was checked is what is used.
// The platform is a parameter so Windows' rules (case-insensitive, backslashes, drive letters) are tested on Linux.
import { randomBytes } from "node:crypto";
import { realpath as fsRealpath, rename, rm, writeFile } from "node:fs/promises";
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

/**
 * A file system error in plain words (never Node's "ENOENT: no such file or directory, stat '…'"): what is wrong with
 * `path`. The caller adds what to type.
 */
export function fsErrorText(e: unknown, path: string): string {
  switch ((e as NodeJS.ErrnoException | null)?.code) {
    case "ENOENT":
      return `${path} isn't there`;
    case "ENOTDIR":
      return `a part of ${path} is a file, not a folder`;
    case "EACCES":
    case "EPERM":
      return `you have no permission to open ${path}`;
    case "EISDIR":
      return `${path} is a folder, not a file`;
    case "ELOOP":
      return `${path}: its links lead round in a circle`;
    case "ENAMETOOLONG":
      return `${path}: the name is too long`;
    case "EBUSY":
    case "EIO":
    case "ETIMEDOUT":
      return `${path} didn't answer (a drive or network share that is busy or gone)`;
  }
  // an error of the app's own ("not a file", "larger than …") is plain already; Node's keep their text after the code
  return `${path}: ${String((e as Error)?.message ?? e).replace(/^[A-Z]+: /, "")}`;
}

export type WriteCheck = { ok: true; path: string } | { ok: false; path: string; reason: string };

/** May the Console write (or delete) at `p`? Yes only inside one of `roots` (each resolved too). */
export async function checkWrite(p: string, cwd: string, roots: readonly string[], d: PathDeps): Promise<WriteCheck> {
  let path: string;
  try {
    path = await resolveReal(p, cwd, d);
  } catch (e) {
    // error: SHOWN — the refusal says why the path couldn't be resolved
    return { ok: false, path: p, reason: `${p} can't be checked: ${fsErrorText(e, p)}` };
  }
  const real: string[] = [];
  // loop: NOT-WORTH — a few chosen folders (the queue's clips), one async realpath each, per write checked
  for (const r of roots) real.push(await resolveReal(r, r, d).catch(() => r));
  // loop: NOT-WORTH — as above
  if (real.some((r) => isInside(path, r, d.platform))) return { ok: true, path };
  const allow = `to let the Console write there, type: ${allowLine(await folderFor(p, path, d), d.platform)}`;
  return {
    ok: false,
    path,
    reason: roots.length
      ? `${path} is outside the folders the Console may write to: ${[...new Set(real)].join(", ")} (the results folder, the cache folder, the queued clips' results folders, the folders you allowed); ${allow}`
      : `${path}: the Console writes only into chosen folders, and none is chosen yet; ${allow}`,
  };
}

/**
 * The folder `allow` would be offered for a refused write: the path itself when it was typed as a folder (ends with a
 * separator), else the nearest folder that exists above it (a missing `v003/` is covered by its parent).
 */
async function folderFor(typed: string, path: string, d: PathDeps): Promise<string> {
  const a = api(d.platform);
  if (/[/\\]$/.test(typed)) return path;
  let cur = a.dirname(path);
  // loop: NOT-WORTH — one async realpath per missing level of one refused path [bounded: the path's depth]
  for (;;) {
    try {
      return await d.realpath(cur);
    } catch {
      // error: NOT-WORTH — not there (yet): its parent is the folder offered
      const parent = a.dirname(cur);
      if (parent === cur) return cur;
      cur = parent;
    }
  }
}

/** The exact line that allows `folder` (always quoted: it is copied as is). */
export function allowLine(folder: string, platform: NodeJS.Platform): string {
  return `allow ${platform === "win32" ? `"${folder}"` : `"${folder.replace(/[\\"]/g, "\\$&")}"`}`;
}

/**
 * Writes `text` at `p` without following a link there (senior review 2026-10-27 M2): into a new file beside it (created
 * exclusively, so never through a link), then renamed over the name, which replaces a link raced in after the checks
 * instead of writing where it points.
 */
export async function replaceFile(p: string, text: string): Promise<void> {
  const tmp = `${p}.${randomBytes(6).toString("hex")}.tmp`;
  // loop: NOT-WORTH — one async write per farm export file
  await writeFile(tmp, text, { encoding: "utf8", flag: "wx" });
  try {
    // loop: NOT-WORTH — one async rename per farm export file
    await rename(tmp, p);
  } catch (e) {
    // error: SHOWN — rethrown for the block; the new file goes
    await rm(tmp, { force: true });
    throw e;
  }
}

/**
 * The next free version (SME review 2026-10-27 S9): a folder in a written path named with `v` and `#`s, `key/sh010_v###/`
 * (a folder: a separator follows it, so it is never a frame pattern's file name), is that folder with the next number
 * not there yet in its parent (`names`): v004 when v001-v003 are, v001 when none is; padded to the #s. Null: no such
 * folder in `path`. Pure.
 */
export function nextVersion(path: string, names: readonly string[], platform: NodeJS.Platform): { parent: string; path: string } | null {
  const sep = platform === "win32" ? "[\\\\/]" : "/";
  const m = new RegExp(`(^|${sep})([^\\\\/#]*?[vV])(#+)([^\\\\/#]*)(?=${sep})`).exec(path);
  if (!m) return null;
  const at = m.index + m[1].length;
  const [head, pad, tail] = [m[2], m[3].length, m[4]];
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc(head)}(\\d+)${esc(tail)}$`, platform === "win32" || platform === "darwin" ? "i" : "");
  let top = 0;
  // loop: NOT-WORTH — one folder's names, once per versioned -o
  for (const n of names) top = Math.max(top, Number(re.exec(n)?.[1] ?? 0));
  return { parent: path.slice(0, at), path: path.slice(0, at) + head + String(top + 1).padStart(pad, "0") + tail + path.slice(at + m[0].length - m[1].length) };
}
