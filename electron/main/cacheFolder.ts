// The cache folder's location (backlog row 44): App settings, Storage chooses where it lives, moves what is in it
// (or starts fresh), and shows what it holds per clip and per TensorRT range.
//
// Safety (Marcy 2026-10-25): only the app's own folders are ever written or removed. A chosen location gets the
// app's own folder inside it (<chosen>/corridorkey-desktop, with a marker file), never the chosen folder itself,
// and an existing folder of that name is used only when it is empty or carries the marker. A move copies every
// file, verifies each copy (size and SHA-256 against the original), and only then removes the originals; on any
// error it removes only the copies it made and leaves the old cache untouched and in use.
//
// Every file-system call here is async (fs/promises): the chosen location can be another drive or a network share, and
// one that stops answering must not freeze the window (loop pass 2026-10-26, finding 2). Job temp files never go
// there: they stay in the system's (local) cache folder whatever the location (jobTempDir; Marcy 2026-10-26).
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, lstat, mkdir, readdir, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { constants } from "node:fs";
import { APP_DIR } from "./platform";
import { folderBytes, TRT_ENGINES_DIR } from "./storage";
import { trtRangeDirs } from "./trtPrebuild";
import type { CacheInfo, Job } from "../../src/shared/types";

/** The marker file in a cache folder the app made in a chosen location. */
export const CACHE_MARKER = ".corridorkey-cache";
/** The cache's parts that move: the clips' thumbnails and stills, and the TensorRT engines built for this card. */
export const MEDIA_DIR = "media";
export const JOBS_DIR = "jobs";
export const MOVED_PARTS = [MEDIA_DIR, TRT_ENGINES_DIR] as const;

/** Whether a path is there (async: a stat on a share that stopped answering doesn't block the main process). */
export const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

/**
 * A job's temp folder: always in the system's cache folder (`systemCache`, a local disk), never in a chosen location.
 * The low-memory passes stream features and baton frames through it every frame (engine pipeline/temps.rs), which on a
 * network share would go over the network (loop pass 2026-10-26, finding 2; Marcy: job temps stay local).
 */
export function jobTempDir(systemCache: string, jobId: string): string {
  return join(systemCache, JOBS_DIR, jobId);
}

/** The cache folder for a setting: the app's own folder inside the chosen location, else the system's. */
export function cacheDirFor(cacheRoot: string | null, defaultDir: string): string {
  return cacheRoot ? join(cacheRoot, APP_DIR) : defaultDir;
}

/**
 * Why the chosen cache folder can't be used now (null: it can, or none is chosen): its location is gone (a drive
 * unplugged, a volume or network share not mounted, a drive letter gone), or the app's marked folder isn't in it
 * (an empty mount point left behind on Linux). The app never makes the chosen location itself, only its own folder
 * inside an existing one.
 */
export async function cacheUnavailable(cacheRoot: string | null, there: (p: string) => Promise<boolean> = exists): Promise<string | null> {
  if (!cacheRoot) return null;
  // loop: NOT-WORTH — one or two async stats, at start and when the cache is about to be written
  if (!(await there(cacheRoot))) return `${cacheRoot} isn't there: is its drive connected?`;
  if (!(await there(join(cacheRoot, APP_DIR, CACHE_MARKER)))) return `The cache folder isn't in ${cacheRoot}: is its drive connected?`;
  return null;
}

const inside = (child: string, parent: string) => {
  const r = relative(resolve(parent), resolve(child));
  // another drive (Windows) comes back absolute
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};

/**
 * Why the cache can't go from `from` to `to` (null: it can). `owned`: `to` is the system's cache folder (always the
 * app's own); any other `to` must be absent, empty, or carry the marker.
 */
export async function targetProblem(from: string, to: string, owned: boolean): Promise<string | null> {
  if (resolve(from) === resolve(to)) return "The cache is already there.";
  if (inside(to, from)) return "That folder is inside the current cache folder.";
  if (inside(from, to)) return "The current cache folder is inside that folder.";
  // the chosen location itself is never made (an unplugged drive's mount path): it must be there
  // loop: NOT-WORTH — one async stat per location choice
  if (!owned && !(await exists(dirname(to)))) return `${dirname(to)} isn't there: is its drive connected?`;
  // loop: NOT-WORTH — one async stat per location choice
  if (owned || !(await exists(to))) return null;
  let names: string[];
  try {
    // loop: NOT-WORTH — one async readdir of the chosen folder, per choice
    names = await readdir(to);
  } catch (e) {
    // error: SHOWN — the choice is refused with why
    return `That folder can't be read: ${(e as Error).message}`;
  }
  if (names.length && !names.includes(CACHE_MARKER)) return `${to} already exists and isn't a CorridorKey cache folder; choose another location.`;
  return null;
}

async function sha256(file: string): Promise<string> {
  const h = createHash("sha256");
  // loop: SERIAL-REQUIRED — streams one file through the hash, async [bounded: the file's size]
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Every file under `dir` (relative paths); anything that isn't a plain file or folder (a link, a device) throws. */
async function filesUnder(dir: string, rel = ""): Promise<string[]> {
  let names: string[];
  try {
    // loop: NOT-WORTH — one readdir per cache folder, once per move
    names = await readdir(join(dir, rel));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" && rel === "") return [];
    throw e;
  }
  const out: string[] = [];
  // loop: NOT-WORTH — the cache's files (a few hundred stills, a few engines), once per move
  for (const n of names) {
    const r = join(rel, n);
    // loop: NOT-WORTH — one lstat per file, once per move
    const s = await lstat(join(dir, r));
    if (s.isDirectory()) out.push(...(await filesUnder(dir, r)));
    else if (s.isFile()) out.push(r);
    else throw new Error(`${join(dir, r)} isn't a plain file (a link or a device): nothing was moved`);
  }
  return out;
}

export interface MoveResult {
  ok: boolean;
  // why the move stopped (ok false), or what couldn't be removed afterwards (ok true)
  message: string | null;
  files: number;
  bytes: number;
}

/** Make `to` the app's cache folder: created, with the marker unless it is the system's folder. */
export async function prepareTarget(to: string, owned: boolean): Promise<void> {
  // a chosen location: only the app's own folder is made, inside a location that is there (never the location itself)
  // loop: NOT-WORTH — one mkdir per location change
  if (owned) await mkdir(to, { recursive: true });
  else
    await mkdir(to).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") throw new Error(`${dirname(to)} isn't there: is its drive connected?`);
      if (e.code !== "EEXIST") throw e;
    });
  // loop: NOT-WORTH — one small write per location change
  if (!owned) await writeFile(join(to, CACHE_MARKER), "CorridorKey Desktop's cache folder. Safe to remove when the app doesn't use it.\n");
}

/**
 * Move the cache's parts (MOVED_PARTS) from `from` to `to`: copy, verify every copy, then remove the originals.
 * Any error before the removal: the copies made are removed, the originals stay, `ok` is false.
 */
export async function moveCache(from: string, to: string, owned: boolean, fromOwned: boolean): Promise<MoveResult> {
  const copied: string[] = [];
  let bytes = 0;
  const plan: { part: string; rel: string }[] = [];
  // a folder made here is removed again if the move stops
  // loop: NOT-WORTH — one async stat per move
  const made = !(await exists(to));
  try {
    // loop: NOT-WORTH — two parts, once per move
    for (const part of MOVED_PARTS) plan.push(...(await filesUnder(join(from, part))).map((rel) => ({ part, rel })));
    // a folder of ours that isn't the cache in use (the system's, or one with the marker): what a move cut short (the app
    // quit mid-copy) left in its parts goes first, or the first leftover stopped every later move (review 2026-10-28 #4)
    // loop: NOT-WORTH — one async stat per move
    if (!made && resolve(from) !== resolve(to) && (owned || (await exists(join(to, CACHE_MARKER)))))
      // loop: NOT-WORTH — two parts, once per move [bounded: the leftovers of one cut move]
      for (const part of MOVED_PARTS) await rm(join(to, part), { recursive: true, force: true });
    await prepareTarget(to, owned);
    // loop: SERIAL-REQUIRED — one file copied and verified at a time, async (a few hundred files, a few GB at most)
    for (const { part, rel } of plan) {
      const src = join(from, part, rel);
      const dst = join(to, part, rel);
      // the drive gone mid-move: never made again at its bare mount path
      // loop: NOT-WORTH — one async stat per file, once per move
      if (!(await exists(to))) throw new Error(`${to} is no longer there: is its drive connected?`);
      // loop: NOT-WORTH — one mkdir per file (exists after the first)
      await mkdir(dirname(dst), { recursive: true });
      // never over a file already there (COPYFILE_EXCL): the target was empty or a cache folder of ours
      // loop: NOT-WORTH — one copy per file, once per move
      await copyFile(src, dst, constants.COPYFILE_EXCL);
      copied.push(dst);
      // loop: NOT-WORTH — two stats per file, once per move
      const [a, b] = await Promise.all([stat(src), stat(dst)]);
      // loop: NOT-WORTH — reads both files once per move
      if (a.size !== b.size || (await sha256(src)) !== (await sha256(dst))) throw new Error(`the copy of ${src} differs from the original`);
      bytes += a.size;
    }
  } catch (e) {
    // error: SHOWN — App settings says why; only the copies made here are removed, the old cache stays in use
    // loop: NOT-WORTH — one unlink per copy made, once per failed move
    for (const f of copied) await unlink(f).catch(() => {});
    // loop: NOT-WORTH — the parts' empty folders, once per failed move
    for (const part of MOVED_PARTS) await removeEmptyDirs(join(to, part));
    if (made) {
      // loop: NOT-WORTH — the marker and the folder, once per failed move (rmdir fails, and keeps it, unless empty)
      await unlink(join(to, CACHE_MARKER)).catch(() => {});
      await rmdir(to).catch(() => {});
    }
    return { ok: false, message: `Nothing was moved: ${(e as Error).message}`, files: 0, bytes: 0 };
  }
  // every copy verified: the originals go (only the files copied)
  let left = 0;
  // loop: NOT-WORTH — one unlink per moved file, once per move
  for (const { part, rel } of plan) await unlink(join(from, part, rel)).catch(() => left++);
  // loop: NOT-WORTH — two parts, once per move
  for (const part of MOVED_PARTS) await removeEmptyDirs(join(from, part));
  await releaseOld(from, fromOwned);
  return { ok: true, message: left ? `${left} old file(s) couldn't be removed from ${from}.` : null, files: copied.length, bytes };
}

/**
 * Remove the old cache after a fresh start in another folder: its parts (MOVED_PARTS and the job folders) only, the
 * app's own folders. `fromOwned`: `from` is the system's cache folder (else a chosen one with the marker, removed
 * when empty). Returns what couldn't be removed (null: all of it).
 */
export async function clearOldCache(from: string, fromOwned: boolean): Promise<string | null> {
  const failed: string[] = [];
  // loop: NOT-WORTH — two parts and the job folders, once per fresh start
  for (const part of [...MOVED_PARTS, JOBS_DIR]) await rm(join(from, part), { recursive: true, force: true }).catch((e: Error) => failed.push(`${join(from, part)} (${e.message})`));
  await releaseOld(from, fromOwned);
  return failed.length ? `The old cache couldn't all be removed: ${failed.join(", ")}.` : null;
}

/** A chosen cache folder left empty: its marker and the folder go (the system's folder stays). */
async function releaseOld(from: string, fromOwned: boolean): Promise<void> {
  if (fromOwned) return;
  await removeEmptyDirs(join(from, JOBS_DIR));
  try {
    // loop: NOT-WORTH — one readdir per location change
    if ((await readdir(from)).every((n) => n === CACHE_MARKER)) {
      // loop: NOT-WORTH — one unlink + rmdir per location change
      await unlink(join(from, CACHE_MARKER)).catch(() => {});
      await rmdir(from);
    }
  } catch {
    // error: NOT-WORTH — something else is in it, or it is gone: it stays as it is
  }
}

/** Remove `dir` and the folders under it that are empty (never a file). */
async function removeEmptyDirs(dir: string): Promise<void> {
  let names: string[];
  try {
    // loop: NOT-WORTH — one readdir per folder, once per move
    names = await readdir(dir);
  } catch {
    // error: NOT-WORTH — no such folder
    return;
  }
  // loop: NOT-WORTH — the cache's folders (a few), once per move
  for (const n of names) {
    // loop: NOT-WORTH — one lstat per entry
    const s = await lstat(join(dir, n)).catch(() => null);
    if (s?.isDirectory()) await removeEmptyDirs(join(dir, n));
  }
  // loop: NOT-WORTH — one rmdir per folder; fails (and stays) when something is left in it
  await rmdir(dir).catch(() => {});
}

/** A ck-media URL's file moved from `oldMedia` to `newMedia` (the same name); any other URL as it is. */
export function remapMedia(url: string, oldMedia: string, newMedia: string, fileOf: (url: string) => string | null, urlOf: (file: string) => string): string {
  const f = fileOf(url);
  if (!f || !inside(f, oldMedia)) return url;
  return urlOf(join(newMedia, relative(oldMedia, f)));
}

const size = (p: string): Promise<number> =>
  // loop: NOT-WORTH — one async stat per still of a queued clip, when App settings shows Storage
  stat(p).then(
    (s) => s.size,
    // error: NOT-WORTH — gone meanwhile: 0
    () => 0,
  );

/**
 * What the cache holds, measured when App settings shows Storage: per clip in the queue its thumbnail and result
 * stills (and its job's working files while it runs: in the system's folder `defaultDir`, jobTempDir), the stills of
 * clips no longer queued, the TensorRT engines per resolution range.
 */
export async function cacheInfo(dir: string, defaultDir: string, jobs: readonly Job[], fileOf: (url: string) => string | null): Promise<Omit<CacheInfo, "moving" | "error">> {
  const media = join(dir, MEDIA_DIR);
  const seen = new Map<string, number>();
  const shots: CacheInfo["shots"] = [];
  // loop: NOT-WORTH — the queue's jobs, when App settings shows Storage
  for (const j of jobs) {
    let bytes = 0;
    // loop: NOT-WORTH — a thumbnail and ≤ four stills per job
    for (const url of [j.clip.thumb, ...j.stills.map((s) => s.url)]) {
      const f = url ? fileOf(url) : null;
      if (!f || !inside(f, media) || seen.has(f)) continue;
      const b = await size(f);
      seen.set(f, b);
      bytes += b;
    }
    shots.push({ name: j.clip.name, bytes: bytes + (await folderBytes(jobTempDir(defaultDir, j.id))) });
  }
  // loop: NOT-WORTH — the attributed stills, as above
  const attributed = [...seen.values()].reduce((n, b) => n + b, 0);
  const trt = join(dir, TRT_ENGINES_DIR);
  const trtRanges: CacheInfo["trtRanges"] = [];
  // the ranges sit one level down, in the card's folder (`<card>/<range>`; listing the card folder named it a range)
  // loop: NOT-WORTH — a few ranges, when App settings shows Storage
  for (const { range, dir: d } of await trtRangeDirs(trt)) trtRanges.push({ range, bytes: await folderBytes(d) });
  return {
    dir,
    defaultDir,
    isDefault: resolve(dir) === resolve(defaultDir),
    bytes: await folderBytes(dir),
    shots,
    otherBytes: Math.max(0, (await folderBytes(media)) - attributed),
    trtRanges,
  };
}
