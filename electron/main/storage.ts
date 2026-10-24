// What the app keeps on disk, measured and removable from App settings, Storage (Marcy 2026-10-24: "good
// stewards of the user's desktop and file system"), and the cache's own pruning at start.
//   runtime: <data>/runtime (the GPU runtime the setup downloads, ~2.4 GB)
//   models:  <data>/models  (the CorridorKey models, ~3.3 GB)
//   cache:   <cache>/media  (clip thumbnails and result stills; rebuilt as needed)
// Settings (userData/settings.json) are a few KB and stay; job temp folders are cleared at start (queue.ts).
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StorageItem } from "../../src/shared/types";
import { MODELS_DIR, RUNTIME_DIR } from "./platform";

export const CACHE_MAX_AGE_DAYS = 30;
export const CACHE_MAX_BYTES = 500e6;

/** Bytes under `dir` (0 when it doesn't exist). Symlinks count as themselves, never followed. */
export function folderBytes(dir: string): number {
  let total = 0;
  let names: string[];
  try {
    // loop: NOT-WORTH — one readdir per folder, only when App settings shows Storage (a few hundred files)
    names = readdirSync(dir);
  } catch {
    // error: NOT-WORTH — no such folder: nothing stored there
    return 0;
  }
  // loop: NOT-WORTH — a few hundred files per measure, only when App settings shows Storage
  for (const n of names) {
    const p = join(dir, n);
    try {
      // loop: NOT-WORTH — one lstat per file, as above
      const s = statSync(p, { throwIfNoEntry: false });
      if (!s) continue;
      total += s.isDirectory() ? folderBytes(p) : s.size;
    } catch {
      // error: NOT-WORTH — removed meanwhile: not counted
    }
  }
  return total;
}

/** `runtimeLabel`: what the runtime is on this system (install.ts systemSupport). */
export function storageItems(data: string, cacheDir: string, runtimeLabel: string): StorageItem[] {
  return [
    { id: "runtime", label: `GPU runtime (${runtimeLabel})`, path: join(data, RUNTIME_DIR), bytes: folderBytes(join(data, RUNTIME_DIR)) },
    { id: "models", label: "CorridorKey models", path: join(data, MODELS_DIR), bytes: folderBytes(join(data, MODELS_DIR)) },
    { id: "cache", label: "Thumbnails and stills (rebuilt as needed)", path: join(cacheDir, "media"), bytes: folderBytes(join(cacheDir, "media")) },
  ];
}

/** Remove one item's folder. The runtime and models come back through the setup's download. */
export function removeStorage(item: StorageItem): void {
  // loop: NOT-WORTH — one folder removed per user click (a confirm dialog first)
  rmSync(item.path, { recursive: true, force: true });
}

/**
 * The cache prunes itself at start: files older than CACHE_MAX_AGE_DAYS go, then the oldest until it is under
 * CACHE_MAX_BYTES. Returns how many files were removed.
 */
export function pruneCache(dir: string, now: number = Date.now(), maxAgeDays = CACHE_MAX_AGE_DAYS, maxBytes = CACHE_MAX_BYTES): number {
  let files: { p: string; mtime: number; size: number }[] = [];
  try {
    // loop: NOT-WORTH — one readdir + a stat per cached still, once per app start
    files = readdirSync(dir).map((n) => {
      // loop: NOT-WORTH — one stat per cached still, once per app start
      const s = statSync(join(dir, n));
      return { p: join(dir, n), mtime: s.mtimeMs, size: s.isFile() ? s.size : 0 };
    });
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
  // loop: NOT-WORTH — removes old stills once per start (local unlinks)
  for (const f of files) {
    if (f.mtime >= cutoff && total <= maxBytes) break;
    // loop: NOT-WORTH — one unlink per pruned still, once per app start
    rmSync(f.p, { force: true, recursive: true });
    total -= f.size;
    removed++;
  }
  return removed;
}
