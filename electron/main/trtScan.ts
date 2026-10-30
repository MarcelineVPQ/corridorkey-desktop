// The TensorRT checklist's folder scan (Marcy 2026-10-30): the app doesn't know which sizes your clips are, so you
// point it at your clips folder and it reads each clip's size (ffprobe for a video, the first frame of an image
// sequence), nothing else: no clip is keyed, copied or changed. The sizes found get their TensorRT windows ticked.
// Bounded: the folder you chose and two folders under it, at most SCAN_MAX_CLIPS clips, and Stop ends it.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expandPaths } from "./media";
import type { ClipKind } from "../../src/shared/types";
import { SCAN_DEPTH, SCAN_MAX_CLIPS } from "../../src/shared/trt";

export interface ScanProgress {
  clips: number;
  found: { width: number; height: number; clips: number }[];
  unreadable: number;
  capped: boolean;
}

export interface ScanDeps {
  // the size of one clip (a video, or a frame folder's first frame); throws when it can't be read
  probe(path: string, kind: ClipKind): Promise<{ width: number; height: number }>;
  // after each clip read: what is found so far
  progress?(p: ScanProgress): void;
  signal?: AbortSignal;
}

/** `dir` and its folders down to `depth` levels (hidden folders skipped); a folder that can't be read is skipped. */
async function folders(dir: string, depth: number, signal?: AbortSignal): Promise<string[]> {
  const out = [dir];
  if (depth === 0 || signal?.aborted) return out;
  let names: string[] = [];
  try {
    // loop: NOT-WORTH — one readdir per folder, at most two levels under the chosen one, once per scan
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    // error: NOT-WORTH — a folder that can't be read has no clips to count
    return out;
  }
  // loop: SERIAL-REQUIRED — one folder at a time, so a big drive isn't read all at once [bounded: SCAN_DEPTH levels]
  for (const n of names.sort()) out.push(...(await folders(join(dir, n), depth - 1, signal)));
  return out;
}

/** Reads the size of every clip in `root` (and SCAN_DEPTH folders under it), at most SCAN_MAX_CLIPS. */
export async function scanClipSizes(root: string, deps: ScanDeps): Promise<ScanProgress> {
  const p: ScanProgress = { clips: 0, found: [], unreadable: 0, capped: false };
  const seen = new Set<string>();
  // loop: SERIAL-REQUIRED — one folder, then one clip at a time (ffprobe each), stopped by the signal [bounded: SCAN_MAX_CLIPS clips]
  for (const dir of await folders(root, SCAN_DEPTH, deps.signal)) {
    if (deps.signal?.aborted) break;
    let clips: { path: string; kind: ClipKind }[] = [];
    try {
      clips = await expandPaths([dir]);
    } catch {
      // error: NOT-WORTH — a folder that can't be read has no clips to count
      continue;
    }
    // loop: SERIAL-REQUIRED — one ffprobe at a time [bounded: SCAN_MAX_CLIPS clips]
    for (const c of clips) {
      if (deps.signal?.aborted) break;
      if (seen.has(c.path)) continue;
      if (p.clips + p.unreadable >= SCAN_MAX_CLIPS) {
        p.capped = true;
        return p;
      }
      seen.add(c.path);
      try {
        const { width, height } = await deps.probe(c.path, c.kind);
        p.clips++;
        // loop: NOT-WORTH — the few sizes found
        const f = p.found.find((x) => x.width === width && x.height === height);
        if (f) f.clips++;
        else p.found.push({ width, height, clips: 1 });
      } catch {
        // error: SHOWN — counted, and the result line says how many couldn't be read
        p.unreadable++;
      }
      deps.progress?.(p);
    }
  }
  return p;
}
