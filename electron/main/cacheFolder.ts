// The cache folder's location (backlog row 44): App settings, Storage chooses where it lives, moves what is in it
// (or starts fresh), and shows what it holds per clip and per TensorRT range.
//
// Safety (Marcy 2026-10-25): only the app's own folders are ever written or removed. A chosen location gets the
// app's own folder inside it (<chosen>/corridorkey-desktop, with a marker file), never the chosen folder itself,
// and an existing folder of that name is used only when it is empty or carries the marker. A move copies every
// file, verifies each copy (size and SHA-256 against the original), and only then removes the originals; on any
// error it removes only the copies it made and leaves the old cache untouched and in use.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { constants } from "node:fs";
import { APP_DIR } from "./platform";
import { folderBytes, TRT_ENGINES_DIR } from "./storage";
import type { CacheInfo, Job } from "../../src/shared/types";

/** The marker file in a cache folder the app made in a chosen location. */
export const CACHE_MARKER = ".corridorkey-cache";
/** The cache's parts that move: the clips' thumbnails and stills, and the TensorRT engines built for this card. */
export const MEDIA_DIR = "media";
export const JOBS_DIR = "jobs";
export const MOVED_PARTS = [MEDIA_DIR, TRT_ENGINES_DIR] as const;

/** The cache folder for a setting: the app's own folder inside the chosen location, else the system's. */
export function cacheDirFor(cacheRoot: string | null, defaultDir: string): string {
  return cacheRoot ? join(cacheRoot, APP_DIR) : defaultDir;
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
export function targetProblem(from: string, to: string, owned: boolean): string | null {
  if (resolve(from) === resolve(to)) return "The cache is already there.";
  if (inside(to, from)) return "That folder is inside the current cache folder.";
  if (inside(from, to)) return "The current cache folder is inside that folder.";
  // loop: NOT-WORTH — one stat per location choice
  if (owned || !existsSync(to)) return null;
  let names: string[];
  try {
    // loop: NOT-WORTH — one readdir of the chosen folder, per choice
    names = readdirSync(to);
  } catch (e) {
    // error: SHOWN — the choice is refused with why
    return `That folder can't be read: ${(e as Error).message}`;
  }
  if (names.length && !names.includes(CACHE_MARKER)) return `${to} already exists and isn't a CorridorKey cache folder; choose another location.`;
  return null;
}

async function sha256(file: string): Promise<string> {
  const h = createHash("sha256");
  // loop: SERIAL-REQUIRED — streams one file through the hash [bounded: the file's size; local disk]
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
  // loop: NOT-WORTH — one mkdir per location change
  await mkdir(to, { recursive: true });
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
  // loop: NOT-WORTH — one stat per move
  const made = !existsSync(to);
  try {
    // loop: NOT-WORTH — two parts, once per move
    for (const part of MOVED_PARTS) plan.push(...(await filesUnder(join(from, part))).map((rel) => ({ part, rel })));
    await prepareTarget(to, owned);
    // loop: SERIAL-REQUIRED — one file copied and verified at a time (local disks; a few hundred files, a few GB at most)
    for (const { part, rel } of plan) {
      const src = join(from, part, rel);
      const dst = join(to, part, rel);
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

const size = (p: string) => {
  try {
    // loop: NOT-WORTH — one stat per still of a queued clip, when App settings shows Storage
    return statSync(p, { throwIfNoEntry: false })?.size ?? 0;
  } catch {
    // error: NOT-WORTH — gone meanwhile: 0
    return 0;
  }
};

/**
 * What the cache holds, measured when App settings shows Storage: per clip in the queue its thumbnail and result
 * stills (and its job's working files while it runs), the stills of clips no longer queued, the TensorRT engines
 * per resolution range.
 */
export function cacheInfo(dir: string, defaultDir: string, jobs: readonly Job[], fileOf: (url: string) => string | null): Omit<CacheInfo, "moving" | "error"> {
  const media = join(dir, MEDIA_DIR);
  const seen = new Set<string>();
  // loop: NOT-WORTH — the queue's jobs, when App settings shows Storage
  const shots = jobs.map((j) => {
    let bytes = 0;
    // loop: NOT-WORTH — a thumbnail and ≤ four stills per job
    for (const url of [j.clip.thumb, ...j.stills.map((s) => s.url)]) {
      const f = url ? fileOf(url) : null;
      if (!f || !inside(f, media) || seen.has(f)) continue;
      seen.add(f);
      bytes += size(f);
    }
    return { name: j.clip.name, bytes: bytes + folderBytes(join(dir, JOBS_DIR, j.id)) };
  });
  // loop: NOT-WORTH — the attributed stills, as above
  const attributed = [...seen].reduce((n, f) => n + size(f), 0);
  const trt = join(dir, TRT_ENGINES_DIR);
  let ranges: string[] = [];
  try {
    // loop: NOT-WORTH — one readdir of the TensorRT engines folder (a few ranges), when App settings shows Storage
    ranges = readdirSync(trt).filter((n) => statSync(join(trt, n)).isDirectory());
  } catch {
    // error: NOT-WORTH — no TensorRT engines built
  }
  // loop: NOT-WORTH — a few ranges, as above
  const trtRanges = ranges.map((range) => ({ range, bytes: folderBytes(join(trt, range)) }));
  return {
    dir,
    defaultDir,
    isDefault: resolve(dir) === resolve(defaultDir),
    bytes: folderBytes(dir),
    shots,
    otherBytes: Math.max(0, folderBytes(media) - attributed),
    trtRanges,
  };
}
