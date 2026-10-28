// Clip facts for the queue: what a dropped path is, its size/fps/frames
// (ffprobe), a small still (ffmpeg), and the companion hints next to it. The
// naming rules are run_interactive.py's, so a folder prepared for the
// upstream launcher works here unchanged.
import { createHash } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { answerWithin } from "./console/paths";
import { run } from "./run";
import type { ClipInfo, ClipKind } from "../../src/shared/types";

export const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".avi", ".mxf", ".webm", ".m4v"]);
export const FRAME_EXT = new Set([".exr", ".png", ".jpg", ".jpeg"]);
export const HINT_IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".exr"]);
const THUMB_WIDTH = 320; // shown at 160 CSS px: 2x for HiDPI, no larger (rule 3)
const STILL_WIDTH = 640; // result stills, shown at up to 320 CSS px
// ffprobe -count_packets reads the whole file (seconds for a large clip on a local disk); a stalled mount or
// device fails the probe (the row says why) instead of holding every clip dropped after it.
const PROBE_TIMEOUT_MS = 120_000;
// one frame seeked and scaled: well under a second normally
const STILL_TIMEOUT_MS = 60_000;
// each folder read and stat of an added clip answers within this (a hung network share fails the add, in words,
// instead of freezing the window: the reads were synchronous); a frame folder of thousands on a share takes seconds
const FS_MS = 30_000;
// loop: NOT-WORTH — one read per call, each bounded by FS_MS
const list = (dir: string) => answerWithin(readdir(dir), FS_MS);
// loop: NOT-WORTH — as above
const statOf = (p: string) => answerWithin(stat(p), FS_MS);
// loop: NOT-WORTH — as above; null: nothing there
const statOrNull = (p: string) =>
  statOf(p).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    // error: PASSES-ON — any other failure (no answer, no access) is the caller's to show
    throw e;
  });

/** "f_2" before "f_10": digit runs compare by value, the rest by text, then plain text (the engine's natural_cmp, clip.rs). */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  // loop: NOT-WORTH — two file names split into runs, per comparison of a sort
  const pa = a.match(re) ?? [];
  // loop: NOT-WORTH — as above
  const pb = b.match(re) ?? [];
  // loop: NOT-WORTH — the runs of two file names, per comparison
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const [x, y] = [pa[i], pb[i]];
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const [dx, dy] = [x.replace(/^0+/, ""), y.replace(/^0+/, "")];
      if (dx.length !== dy.length) return dx.length - dy.length;
      if (dx !== dy) return dx < dy ? -1 : 1;
      // equal values with different zero padding: decided by what follows, then by plain text below
      if (x.length !== y.length) continue;
    } else if (x !== y) {
      // runs that differ: compare char by char like the engine (byte order)
      const n = Math.min(x.length, y.length);
      // loop: NOT-WORTH — the characters of one run
      for (let k = 0; k < n; k++) if (x[k] !== y[k]) return x.charCodeAt(k) - y.charCodeAt(k);
      return x.length - y.length;
    }
  }
  if (pa.length !== pb.length) return pa.length - pb.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The frame files of a folder (any case of .exr/.png/.jpg), in the engine's natural order (CorridorKey2.0 PR #4). */
export async function frameFiles(dir: string): Promise<string[]> {
  // loop: HOT-PATH-OK — one readdir per added folder, not per frame of playback
  return (
    (await list(dir))
      // loop: NOT-WORTH — a frame folder's names, once per probe
      .filter((f) => FRAME_EXT.has(extname(f).toLowerCase()))
      .sort(naturalCompare)
      .map((f) => join(dir, f))
  );
}

/**
 * Whether a frame folder's frames are scene-linear by their format, as the engine reads it (its first frame in natural
 * order): OpenEXR plates are scene-linear by convention, PNG/JPEG display-coded (Marcy 2026-10-27: an EXR folder read
 * as display-coded clipped every value above 1). A folder's box starts here; a change to it is that folder's alone.
 */
export async function frameDirLinearFor(dir: string): Promise<boolean> {
  const first = (await frameFiles(dir))[0];
  return first !== undefined && extname(first).toLowerCase() === ".exr";
}

/** Whether a folder holds any frame file: a scan, no sort (the sort happens once, in probeClip; leak audit 2026-10-24, #9). */
export async function hasFrames(dir: string): Promise<boolean> {
  // loop: NOT-WORTH — one readdir per added folder
  return (await list(dir)).some((f) => FRAME_EXT.has(extname(f).toLowerCase()));
}

/** The first of `names` in `dir` (any case) that is a folder, or undefined. */
async function subfolder(dir: string, names: readonly string[], want: string): Promise<string | undefined> {
  // loop: NOT-WORTH — one stat per same-named entry (one, two), once per added folder
  for (const n of names) if (n.toLowerCase() === want && (await statOf(join(dir, n))).isDirectory()) return n;
  return undefined;
}

/**
 * Expand dropped paths into clips: videos, frame folders, and folders of clips (one level). A path that is gone is
 * skipped; one that can't be read (no answer within FS_MS, no access) rejects, naming it.
 */
export async function expandPaths(paths: string[]): Promise<{ path: string; kind: ClipKind }[]> {
  const out: { path: string; kind: ClipKind }[] = [];
  // loop: SERIAL-REQUIRED — a handful of dropped paths, once per drop, in the order dropped [bounded: FS_MS per read]
  for (const p of paths) {
    try {
      const st = await statOrNull(p);
      if (!st) continue;
      if (st.isFile()) {
        if (VIDEO_EXT.has(extname(p).toLowerCase()) && !isCompanionHint(p)) out.push({ path: p, kind: "video" });
        continue;
      }
      const names = await list(p);
      // run_interactive.py's sequence layout: <shot>/Input (+ <shot>/AlphaHint)
      const input = await subfolder(p, names, "input");
      if (input) {
        out.push({ path: join(p, input), kind: "frames" });
        continue;
      }
      // loop: NOT-WORTH — a dropped folder's names, once per drop
      if (names.some((f) => FRAME_EXT.has(extname(f).toLowerCase()))) {
        out.push({ path: p, kind: "frames" });
        continue;
      }
      // loop: SERIAL-REQUIRED — one folder level of a dropped batch folder, once per drop [bounded: FS_MS per stat]
      for (const name of names.sort()) {
        const child = join(p, name);
        if (VIDEO_EXT.has(extname(name).toLowerCase()) && !isCompanionHint(child) && (await statOf(child)).isFile()) out.push({ path: child, kind: "video" });
      }
    } catch (e) {
      // error: PASSES-ON — the add says which path couldn't be read, and why (index.ts addPaths)
      throw new Error(`${p}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** A hint video that sits next to its clip (<clip>_AlphaHint.mp4) is not a clip of its own. */
export function isCompanionHint(path: string): boolean {
  return /[_\- ]?alphahint$/i.test(basename(path, extname(path))) || /framehint$/i.test(basename(path, extname(path)));
}

async function companions(dir: string, stem: string, exts: Set<string>, markers: string[]): Promise<string | null> {
  if (!(await statOrNull(dir))) return null;
  const base = stem.toLowerCase();
  const found = new Map<string, string>();
  // loop: SERIAL-REQUIRED — one readdir of the clip's folder, once per added clip [bounded: FS_MS per read]
  for (const name of (await list(dir)).sort()) {
    const full = join(dir, name);
    if (!exts.has(extname(name).toLowerCase())) continue;
    const s = basename(name, extname(name)).toLowerCase();
    if (!s.startsWith(base)) continue;
    const rest = s.slice(base.length).replace(/^[_\- ]+/, "");
    // loop: NOT-WORTH — a few hint markers per file name
    const marker = markers.find((m) => rest.startsWith(m));
    // one stat per candidate hint file, once per probed clip
    if (marker && !found.has(marker) && (await statOf(full)).isFile()) found.set(marker, full);
  }
  // loop: NOT-WORTH — at most two markers
  for (const m of markers) if (found.has(m)) return found.get(m)!;
  return null;
}

/** First-frame hint: <clip>FrameHint.png (preferred), else the older <clip>_alphahint image. */
export function findFirstFrameHint(clip: string): Promise<string | null> {
  return companions(dirname(clip), basename(clip, extname(clip)), HINT_IMAGE_EXT, ["framehint", "alphahint"]);
}

/** Full hint video: <clip>_AlphaHint.<video ext>; for a <shot>/Input folder, <shot>/AlphaHint. */
export async function findHintVideo(clip: string, kind: ClipKind): Promise<string | null> {
  if (kind === "frames") {
    const shot = dirname(clip);
    if (basename(clip).toLowerCase() !== "input") return null;
    const hint = await subfolder(shot, await list(shot), "alphahint");
    return hint ? join(shot, hint) : null;
  }
  return companions(dirname(clip), basename(clip, extname(clip)), VIDEO_EXT, ["alphahint"]);
}

/** The runtime's clip name (video_io.raw_clip_name): a folder called input/frames/rgb takes its parent's name. */
export function clipName(path: string): string {
  const name = basename(path, extname(path));
  return ["input", "frames", "rgb"].includes(name.toLowerCase()) ? basename(dirname(path)) : name;
}

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  // loop: NOT-WORTH — a rate's two numbers
  const [n, d] = rate.split("/").map(Number);
  if (!n) return null;
  return d ? n / d : n;
}

export async function probeVideo(path: string): Promise<{ width: number; height: number; fps: number | null; frames: number | null }> {
  const { stdout } = await run(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate,nb_read_packets", "-of", "json", path],
    {
      maxBuffer: 1 << 20,
      timeout: PROBE_TIMEOUT_MS,
    },
  );
  const s = (JSON.parse(stdout) as { streams?: Record<string, string | number>[] }).streams?.[0];
  if (!s) throw new Error("no video stream");
  const frames = Number(s.nb_read_packets);
  return {
    width: Number(s.width),
    height: Number(s.height),
    fps: parseRate(String(s.avg_frame_rate)) ?? parseRate(String(s.r_frame_rate)),
    frames: Number.isFinite(frames) && frames > 0 ? frames : null,
  };
}

async function probeImage(path: string): Promise<{ width: number; height: number }> {
  // loop: SERIAL-REQUIRED — ffprobe of one frame image per probed folder, PROBE_TIMEOUT_MS (this pass: had none)
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", path], { maxBuffer: 1 << 20, timeout: PROBE_TIMEOUT_MS });
  const s = (JSON.parse(stdout) as { streams?: { width: number; height: number }[] }).streams?.[0];
  if (!s) throw new Error("not an image");
  return { width: s.width, height: s.height };
}

/**
 * One frame of `source` at `seconds`, scaled to `width`, cached by path+mtime+time. Returns the file path.
 * Converted to RGB before the JPEG: straight from the engine's yuv444p10le TV-range video, ffmpeg's yuvj420p rounded
 * near-black chroma to green, faint green lines in black areas (Marcy 2026-10-27). "rgb" in the cache key: the green
 * stills made before are not reused.
 */
export async function still(cacheDir: string, source: string, seconds: number, width: number): Promise<string> {
  // loop: NOT-WORTH — one mkdir (exists after the first) per still [bounded: FS_MS]
  await answerWithin(mkdir(cacheDir, { recursive: true }), FS_MS);
  const key = createHash("sha1")
    // one stat per still (the cache key)
    .update(`${source}|${(await statOf(source)).mtimeMs}|${seconds}|${width}|rgb`)
    .digest("hex")
    .slice(0, 20);
  const out = join(cacheDir, `${key}.jpg`);
  // one stat per still (cache hit check)
  if (await statOrNull(out)) return out;
  const seek = seconds > 0 ? ["-ss", seconds.toFixed(3)] : [];
  // loop: SERIAL-REQUIRED — one ffmpeg still at a time, STILL_TIMEOUT_MS (this pass: had none)
  await run("ffmpeg", ["-v", "error", "-y", ...seek, "-i", source, "-frames:v", "1", "-vf", `scale=${width}:-2,format=rgb24`, "-q:v", "4", out], { timeout: STILL_TIMEOUT_MS });
  return out;
}

export async function probeClip(path: string, kind: ClipKind, cacheDir: string, mediaUrl: (file: string) => string): Promise<ClipInfo> {
  const info: ClipInfo = {
    path,
    name: clipName(path),
    kind,
    width: null,
    height: null,
    fps: null,
    frames: null,
    thumb: null,
    companionFirstFrame: null,
    companionHintVideo: null,
    exrFrames: false,
    probeError: null,
  };
  try {
    if (kind === "video") info.companionFirstFrame = await findFirstFrameHint(path);
    info.companionHintVideo = await findHintVideo(path, kind);
    if (kind === "video") {
      const v = await probeVideo(path);
      Object.assign(info, v);
      const middle = v.frames && v.fps ? v.frames / v.fps / 2 : 0;
      info.thumb = mediaUrl(await still(cacheDir, path, middle, THUMB_WIDTH));
    } else {
      const files = await frameFiles(path);
      if (files.length === 0) throw new Error("no EXR/PNG/JPG frames in this folder");
      info.exrFrames = extname(files[0]).toLowerCase() === ".exr";
      const mid = files[Math.floor(files.length / 2)];
      Object.assign(info, await probeImage(mid));
      info.frames = files.length;
      info.thumb = mediaUrl(await still(cacheDir, mid, 0, THUMB_WIDTH));
    }
  } catch (e) {
    // error: SHOWN — the queue row says why this clip couldn't be read
    info.probeError = e instanceof Error ? e.message.split("\n")[0] : String(e);
  }
  return info;
}

export { STILL_WIDTH };
