// Clip facts for the queue: what a dropped path is, its size/fps/frames
// (ffprobe), a small still (ffmpeg), and the companion hints next to it. The
// naming rules are run_interactive.py's, so a folder prepared for the
// upstream launcher works here unchanged.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
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
export function frameFiles(dir: string): string[] {
  // loop: HOT-PATH-OK — one readdir per added folder, not per frame of playback
  return (
    readdirSync(dir)
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
export function frameDirLinearFor(dir: string): boolean {
  const first = frameFiles(dir)[0];
  return first !== undefined && extname(first).toLowerCase() === ".exr";
}

/** Whether a folder holds any frame file: a scan, no sort (the sort happens once, in probeClip; leak audit 2026-10-24, #9). */
export function hasFrames(dir: string): boolean {
  // loop: NOT-WORTH — one readdir per added folder, stops at the first frame file
  return readdirSync(dir).some((f) => FRAME_EXT.has(extname(f).toLowerCase()));
}

/** Expand dropped paths into clips: videos, frame folders, and folders of clips (one level). */
export function expandPaths(paths: string[]): { path: string; kind: ClipKind }[] {
  const out: { path: string; kind: ClipKind }[] = [];
  // loop: NOT-WORTH — a handful of dropped paths, once per drop
  for (const p of paths) {
    // loop: NOT-WORTH — one stat per dropped path, once per drop (blocking but local; the drop is a user action)
    if (!existsSync(p)) continue;
    // loop: NOT-WORTH — one stat per dropped path, once per drop
    if (statSync(p).isFile()) {
      if (VIDEO_EXT.has(extname(p).toLowerCase()) && !isCompanionHint(p)) out.push({ path: p, kind: "video" });
      continue;
    }
    // run_interactive.py's sequence layout: <shot>/Input (+ <shot>/AlphaHint)
    // loop: NOT-WORTH — one readdir + a stat per entry of a dropped folder, once per drop
    const input = readdirSync(p).find((n) => n.toLowerCase() === "input" && statSync(join(p, n)).isDirectory());
    if (input) {
      out.push({ path: join(p, input), kind: "frames" });
      continue;
    }
    if (hasFrames(p)) {
      out.push({ path: p, kind: "frames" });
      continue;
    }
    // loop: NOT-WORTH — one folder level of a dropped batch folder, once per drop
    for (const name of readdirSync(p).sort()) {
      const child = join(p, name);
      // loop: NOT-WORTH — one stat per entry of a dropped folder, once per drop
      if (statSync(child).isFile() && VIDEO_EXT.has(extname(name).toLowerCase()) && !isCompanionHint(child)) out.push({ path: child, kind: "video" });
    }
  }
  return out;
}

/** A hint video that sits next to its clip (<clip>_AlphaHint.mp4) is not a clip of its own. */
export function isCompanionHint(path: string): boolean {
  return /[_\- ]?alphahint$/i.test(basename(path, extname(path))) || /framehint$/i.test(basename(path, extname(path)));
}

function companions(dir: string, stem: string, exts: Set<string>, markers: string[]): string | null {
  // loop: NOT-WORTH — one stat per hint lookup, once per probed clip
  if (!existsSync(dir)) return null;
  const base = stem.toLowerCase();
  const found = new Map<string, string>();
  // loop: NOT-WORTH — one readdir of the clip's folder, once per added clip
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    // loop: NOT-WORTH — one stat per candidate hint file, once per probed clip
    if (!exts.has(extname(name).toLowerCase()) || !statSync(full).isFile()) continue;
    const s = basename(name, extname(name)).toLowerCase();
    if (!s.startsWith(base)) continue;
    const rest = s.slice(base.length).replace(/^[_\- ]+/, "");
    // loop: NOT-WORTH — a few hint markers per file name
    const marker = markers.find((m) => rest.startsWith(m));
    if (marker && !found.has(marker)) found.set(marker, full);
  }
  // loop: NOT-WORTH — at most two markers
  for (const m of markers) if (found.has(m)) return found.get(m)!;
  return null;
}

/** First-frame hint: <clip>FrameHint.png (preferred), else the older <clip>_alphahint image. */
export function findFirstFrameHint(clip: string): string | null {
  return companions(dirname(clip), basename(clip, extname(clip)), HINT_IMAGE_EXT, ["framehint", "alphahint"]);
}

/** Full hint video: <clip>_AlphaHint.<video ext>; for a <shot>/Input folder, <shot>/AlphaHint. */
export function findHintVideo(clip: string, kind: ClipKind): string | null {
  if (kind === "frames") {
    const shot = dirname(clip);
    if (basename(clip).toLowerCase() !== "input") return null;
    // loop: NOT-WORTH — one readdir of a shot folder + a stat, once per probed clip
    const hint = readdirSync(shot).find((n) => n.toLowerCase() === "alphahint" && statSync(join(shot, n)).isDirectory());
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
  // loop: NOT-WORTH — one mkdir (exists after the first) per still
  mkdirSync(cacheDir, { recursive: true });
  const key = createHash("sha1")
    // loop: NOT-WORTH — one stat per still (the cache key)
    .update(`${source}|${statSync(source).mtimeMs}|${seconds}|${width}|rgb`)
    .digest("hex")
    .slice(0, 20);
  const out = join(cacheDir, `${key}.jpg`);
  // loop: NOT-WORTH — one stat per still (cache hit check)
  if (existsSync(out)) return out;
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
    companionFirstFrame: kind === "video" ? findFirstFrameHint(path) : null,
    companionHintVideo: findHintVideo(path, kind),
    exrFrames: false,
    probeError: null,
  };
  try {
    if (kind === "video") {
      const v = await probeVideo(path);
      Object.assign(info, v);
      const middle = v.frames && v.fps ? v.frames / v.fps / 2 : 0;
      info.thumb = mediaUrl(await still(cacheDir, path, middle, THUMB_WIDTH));
    } else {
      const files = frameFiles(path);
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
