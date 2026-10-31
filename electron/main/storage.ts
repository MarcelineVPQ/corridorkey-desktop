// What the app keeps on disk, measured and removable from App settings, Storage (Marcy 2026-10-24: the
// app takes good care of the user's desktop and file system), and the cache's own pruning at start.
//   runtime: <data>/runtime (the GPU runtime the setup downloads, ~2.4 GB)
//   models:  <data>/models  (the CorridorKey models, ~2.5 GB; ~5.5 GB on macOS with the Core ML set)
//   tensorrt: the opt-in TensorRT parts inside those two (install.ts: its libraries in the runtime, its models in the
//            set's folder), measured on their own and taken out of the runtime's and models' sizes (Linux only)
//   cache:   <cache>/media  (clip thumbnails and result stills; rebuilt as needed)
// Settings (userData/settings.json) are a few KB and stay; job temp folders are cleared at start (queue.ts).
// Every read and removal here is async (fs/promises): the cache folder can be on another drive or a network share
// (backlog row 44), and a share that stops answering must not freeze the window (loop pass 2026-10-26, finding 2).
import { readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { StorageItem } from "../../src/shared/types";
import { MODELS_DIR, PLATFORM, RUNTIME_DIR } from "./platform";
import { removeTensorrt, TENSORRT, TRT_DIST_INFO, TRT_MODELS_LIST, trtPaths, type TrtCatalog } from "./install";

/** The TensorRT engines the engine builds for this card, in the app's cache folder (index.ts passes it as trtCache). */
export const TRT_ENGINES_DIR = "tensorrt";
export const CACHE_MAX_AGE_DAYS = 30;
export const CACHE_MAX_BYTES = 500e6;

/**
 * Bytes under `dir` (0 when it doesn't exist). Links are followed (a model set linked from another drive counts its files,
 * as tensorrtBytes does). A link loop ends at the system's link limit (40 levels; measured: a folder linking to itself
 * counts its files 41 times); the app makes no links.
 */
export async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    // loop: NOT-WORTH — one async readdir per folder, only when App settings shows Storage (a few hundred files)
    names = await readdir(dir);
  } catch {
    // error: NOT-WORTH — no such folder: nothing stored there
    return 0;
  }
  // loop: NOT-WORTH — a few hundred files per measure, only when App settings shows Storage
  for (const n of names) {
    const p = join(dir, n);
    try {
      // loop: NOT-WORTH — one async stat per file, as above
      const s = await stat(p);
      total += s.isDirectory() ? await folderBytes(p) : s.size;
    } catch {
      // error: NOT-WORTH — removed meanwhile (or a dangling link): not counted
    }
  }
  return total;
}

/** The TensorRT parts' bytes: in the runtime (libraries, licence) and in the model set (its files and list). */
export async function tensorrtBytes(data: string, c?: TrtCatalog): Promise<{ runtime: number; models: number }> {
  const p = trtPaths(data, c);
  let licence = 0;
  try {
    // loop: NOT-WORTH — the runtime folder's few entries, only when App settings shows Storage
    for (const d of (await readdir(p.runtime)).filter((n) => TRT_DIST_INFO.test(n))) licence += await folderBytes(join(p.runtime, d));
  } catch {
    // error: NOT-WORTH — no runtime installed: nothing of TensorRT's there
  }
  // loop: NOT-WORTH — sixteen names, only when App settings shows Storage
  const files = [TRT_MODELS_LIST, ...(c?.trtModels ?? TENSORRT.models).files.map((x) => x.file).filter((n) => n !== "models.json")];
  let models = 0;
  // loop: NOT-WORTH — sixteen async stats, only when App settings shows Storage
  for (const f of files) models += (await stat(join(p.models, f)).catch(() => null))?.size ?? 0;
  return { runtime: (await folderBytes(p.libs)) + licence, models };
}

/** `runtimeLabel`: what the runtime is on this system (install.ts systemSupport). TensorRT: Linux only. */
export async function storageItems(data: string, cacheDir: string, runtimeLabel: string, platform: NodeJS.Platform = PLATFORM, c?: TrtCatalog): Promise<StorageItem[]> {
  const trt = platform === "linux" ? await tensorrtBytes(data, c) : { runtime: 0, models: 0 };
  const items: StorageItem[] = [
    { id: "runtime", label: `GPU runtime (${runtimeLabel})`, path: join(data, RUNTIME_DIR), bytes: (await folderBytes(join(data, RUNTIME_DIR))) - trt.runtime },
    { id: "models", label: "CorridorKey models", path: join(data, MODELS_DIR), bytes: (await folderBytes(join(data, MODELS_DIR))) - trt.models },
  ];
  // the engines built for this card (engine.ts trtCache: <cache>/tensorrt) belong to it too
  if (platform === "linux")
    items.push({
      id: "tensorrt",
      label: "TensorRT (NVIDIA's libraries, the TensorRT models, the engines built for your card)",
      path: trtPaths(data, c).libs,
      bytes: trt.runtime + trt.models + (await folderBytes(join(cacheDir, TRT_ENGINES_DIR))),
    });
  items.push({ id: "cache", label: "Thumbnails and stills (rebuilt as needed)", path: join(cacheDir, "media"), bytes: await folderBytes(join(cacheDir, "media")) });
  return items;
}

/**
 * Remove one item. The runtime and models come back through the setup's download, TensorRT through its switch.
 * TensorRT's parts live inside the runtime and the model set: install.ts removes exactly those.
 */
export async function removeStorage(item: StorageItem, data: string, cacheDir: string, c?: TrtCatalog): Promise<void> {
  if (item.id === "tensorrt") {
    removeTensorrt(data, c);
    await removeAside(join(cacheDir, TRT_ENGINES_DIR));
    return;
  }
  await removeAside(item.path);
}

/**
 * Remove a folder by renaming it aside first (`.<name>.removing` beside it), so it is gone at once for everything that
 * looks for it (an engine start, a measure), then deleting that. A leftover of an earlier removal cut short goes first.
 */
export async function removeAside(dir: string): Promise<void> {
  const aside = join(dirname(dir), `.${basename(dir)}.removing`);
  // loop: NOT-WORTH — one folder removed (async) per user click (a confirm dialog first)
  await rm(aside, { recursive: true, force: true });
  try {
    // loop: NOT-WORTH — one rename per user click
    await rename(dir, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    // error: NOT-WORTH — not renamable (a file in use on Windows): removed in place below
    // loop: NOT-WORTH — as above
    await rm(dir, { recursive: true, force: true });
    return;
  }
  // loop: NOT-WORTH — as above
  await rm(aside, { recursive: true, force: true });
}

/**
 * At start: delete the `.<name>.removing` folders a removal cut short left (removeAside: a quit or a crash between the
 * rename and the delete) in the folders it removes from. Returns how many went.
 */
export async function sweepRemoving(parents: readonly string[]): Promise<number> {
  let n = 0;
  // loop: NOT-WORTH — the app's data and cache folders, once at start
  for (const parent of parents) {
    // error: NOT-WORTH — a folder not there (yet) has nothing to sweep
    const names = await readdir(parent).catch(() => [] as string[]);
    // loop: NOT-WORTH — the folder's few entries, once at start
    for (const name of names.filter((x) => /^\..+\.removing$/.test(x))) {
      // loop: NOT-WORTH — one leftover folder removed (async)
      await rm(join(parent, name), { recursive: true, force: true });
      n++;
    }
  }
  return n;
}

/**
 * The cache prunes itself at start: files older than CACHE_MAX_AGE_DAYS go, then the oldest until it is under
 * CACHE_MAX_BYTES. Returns how many files were removed.
 */
export async function pruneCache(dir: string, now: number = Date.now(), maxAgeDays = CACHE_MAX_AGE_DAYS, maxBytes = CACHE_MAX_BYTES): Promise<number> {
  let files: { p: string; mtime: number; size: number }[] = [];
  try {
    // loop: NOT-WORTH — one async readdir + a stat per cached still, once per app start
    const names = await readdir(dir);
    // loop: NOT-WORTH — one async stat per cached still, once per app start
    for (const n of names) {
      const s = await stat(join(dir, n));
      files.push({ p: join(dir, n), mtime: s.mtimeMs, size: s.isFile() ? s.size : 0 });
    }
  } catch {
    // error: NOT-WORTH — no cache yet: nothing to prune
    return 0;
  }
  const cutoff = now - maxAgeDays * 86_400_000;
  let removed = 0;
  // loop: NOT-WORTH — sorts the cached stills once per start (oldest first)
  files.sort((a, b) => a.mtime - b.mtime);
  // loop: NOT-WORTH — sums the cached stills once per start
  let total = files.reduce((n, f) => n + f.size, 0);
  // loop: NOT-WORTH — removes old stills once per start (a few async unlinks)
  for (const f of files) {
    if (f.mtime >= cutoff && total <= maxBytes) break;
    // loop: NOT-WORTH — one async unlink per pruned still, once per app start
    await rm(f.p, { force: true, recursive: true });
    total -= f.size;
    removed++;
  }
  return removed;
}
