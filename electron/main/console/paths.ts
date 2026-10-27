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

/** A read of the file system (readdir, stat, lstat, realpath) answers within this, or the Console says it didn't. */
export const FS_ANSWER_MS = 3000;

/**
 * `p`, or an ETIMEDOUT error once `ms` have passed (senior review 2026-10-26 N11: Tab or `dir` on a hung network share
 * left the request pending, the page showing nothing). The read itself goes on; its late answer is dropped.
 */
export function answerWithin<T>(p: Promise<T>, ms = FS_ANSWER_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // loop: NOT-WORTH — one deadline per file system read [bounded: ms]
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(Object.assign(new Error("no answer"), { code: "ETIMEDOUT" })), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** `~` and `~/…` (`~\…` on Windows) are the home folder; nothing else is expanded. */
export function expandHome(p: string, d: Pick<PathDeps, "home" | "platform">): string {
  if (p === "~") return d.home;
  if (p.startsWith("~/") || (d.platform === "win32" && p.startsWith("~\\"))) return api(d.platform).join(d.home, p.slice(2));
  return p;
}

/** The absolute, symlink-free path `p` (relative to `cwd`) names; a missing tail is kept as typed below its real parent. */
export async function resolveReal(p: string, cwd: string, d: PathDeps): Promise<string> {
  const { real, tail } = await resolveRealParts(p, cwd, d);
  return api(d.platform).join(real, ...tail);
}

/** resolveReal in two parts: what realpath returned, and the missing tail below it as typed. */
async function resolveRealParts(p: string, cwd: string, d: PathDeps): Promise<{ real: string; tail: string[] }> {
  const a = api(d.platform);
  const abs = a.resolve(cwd, expandHome(p, d));
  const tail: string[] = [];
  let cur = abs;
  // loop: NOT-WORTH — one async realpath per missing path level [bounded: the path's depth]
  for (;;) {
    try {
      return { real: await d.realpath(cur), tail: tail.reverse() };
    } catch (e) {
      // error: SHOWN — only "not there (yet)" walks up; anything else (no permission) is the caller's refusal
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      const parent = a.dirname(cur);
      if (parent === cur) return { real: abs, tail: [] };
      tail.push(a.basename(cur));
      cur = parent;
    }
  }
}

/** A normalized absolute path as its root (`/`, `C:\`, `\\host\share\`) then its names. */
function components(p: string, platform: NodeJS.Platform): string[] {
  const a = api(platform);
  const n = a.normalize(p);
  const root = a.parse(n).root;
  // loop: NOT-WORTH — one path's names
  return [root, ...n.slice(root.length).split(a.sep).filter(Boolean)];
}

/**
 * Whether `child` is `root` or inside it (both absolute and resolved). Windows and macOS compare names without case,
 * but only the first `foldUpTo` names (root included): the part realpath returned for both. A name below that was
 * typed for a folder not there yet, so it is compared as typed: on a case-sensitive volume `results` isn't `Results`
 * (senior review 2026-10-26 N3).
 */
export function isInside(child: string, root: string, platform: NodeJS.Platform, foldUpTo = Infinity): boolean {
  const [c, r] = [components(child, platform), components(root, platform)];
  const same = (x: string, y: string, i: number) => x === y || (foldsCase(platform) && i < foldUpTo && x.toLowerCase() === y.toLowerCase());
  // loop: NOT-WORTH — a root's few names
  return c.length >= r.length && r.every((x, i) => same(c[i], x, i));
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
    case "ESERVER": {
      const server = (e as { server: string }).server;
      return `${path} is on the network server ${server}, which the Console hasn't opened this session (Windows sends your sign-in to every server it opens); if you trust it, type: allow-server ${server}`;
    }
  }
  // an error of the app's own ("not a file", "larger than …") is plain already; Node's keep their text after the code
  return `${path}: ${String((e as Error)?.message ?? e).replace(/^[A-Z]+: /, "")}`;
}

export type WriteCheck = { ok: true; path: string } | { ok: false; path: string; reason: string };

/** May the Console write (or delete) at `p`? Yes only inside one of `roots` (each resolved too). */
export async function checkWrite(p: string, cwd: string, roots: readonly string[], d: PathDeps): Promise<WriteCheck> {
  let path: string;
  let parts: { real: string; tail: string[] };
  try {
    parts = await resolveRealParts(p, cwd, d);
    path = api(d.platform).join(parts.real, ...parts.tail);
  } catch (e) {
    // error: SHOWN — the refusal says why the path couldn't be resolved
    return { ok: false, path: p, reason: `${p} can't be checked: ${fsErrorText(e, p)}` };
  }
  const real: string[] = [];
  const inside: boolean[] = [];
  const realNames = components(parts.real, d.platform).length;
  // loop: NOT-WORTH — a few chosen folders (the queue's clips), one async realpath each, per write checked
  for (const r of roots) {
    const rp = await resolveRealParts(r, r, d).catch(() => ({ real: r, tail: [] as string[] }));
    const root = api(d.platform).join(rp.real, ...rp.tail);
    real.push(root);
    inside.push(isInside(path, root, d.platform, Math.min(realNames, components(rp.real, d.platform).length)));
  }
  if (inside.includes(true)) return { ok: true, path };
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
 * The system folders `allow` refuses, and everything inside them (backlog row 136, Marcy 2026-10-27): on Windows the
 * system's folders from the environment (%SystemRoot%, %ProgramFiles%, %ProgramFiles(x86)%, %ProgramData%; a drive's
 * root is refused as every root is). The caller adds their realpaths (/bin → /usr/bin, /etc → /private/etc). Pure.
 */
export function systemFolders(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32")
    // loop: NOT-WORTH — four variables
    return ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"].flatMap((k) => (env[k] && win32.isAbsolute(env[k]) ? [env[k]] : []));
  if (platform === "darwin") return ["/System", "/Library", "/usr", "/bin", "/sbin", "/dev", "/etc", "/var", "/private/etc", "/private/var"];
  return ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var"];
}

/**
 * What `allow` does with `dir` (resolved; `home` and `system` resolved too): "refuse" a root (`/`, `C:\`, a share's
 * root) or a system folder or a folder inside one; "home" the home folder itself (a warning in the confirmation);
 * "ok" anything else. A folder inside home is "ok" even where home lives below a system folder (/var/home on Fedora
 * Silverblue), and so is /run/media on Linux (where removable drives are mounted). Pure.
 */
export function allowVerdict(dir: string, home: string, system: readonly string[], platform: NodeJS.Platform): "refuse" | "home" | "ok" {
  if (isInside(dir, home, platform)) return isInside(home, dir, platform) ? "home" : "ok";
  if (components(dir, platform).length === 1) return "refuse";
  if (platform === "linux" && isInside(dir, "/run/media", platform)) return "ok";
  // loop: NOT-WORTH — ≤ 15 system folders and their realpaths
  return system.some((s) => isInside(dir, s, platform)) ? "refuse" : "ok";
}

/**
 * The network server a Windows path opens (backlog row 139), lower case: `\\host\share\…`, `//host/…` and
 * `\\?\UNC\host\…` → host. A device path other than a drive (`\\.\pipe\…`, `\\?\GLOBALROOT\…`) → its first name, so
 * it too needs allow-server. A drive path, and every path on Linux and macOS → null. Pure.
 */
export function uncServer(p: string, platform: NodeJS.Platform): string | null {
  if (platform !== "win32") return null;
  const m = /^[\\/]{2}([^\\/]+)(?:[\\/]+([^\\/]*))?(?:[\\/]+([^\\/]*))?/.exec(p);
  if (!m) return null;
  const [, first, second, third] = m;
  if (first !== "?" && first !== ".") return first.toLowerCase();
  if (!second || /^[a-z]:$/i.test(second)) return null;
  return (second.toUpperCase() === "UNC" && third ? third : second).toLowerCase();
}

/** The error a Console read or write of a server not allowed this session gets (fsErrorText says what to type). */
export function serverNotAllowed(server: string): Error {
  return Object.assign(new Error(`the network server ${server} isn't allowed this session`), { code: "ESERVER", server });
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
