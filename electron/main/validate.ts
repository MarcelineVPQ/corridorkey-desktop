// What comes from outside the main process is checked here before it is used: the page's IPC arguments (the
// renderer is sandboxed, but its messages are still input) and the settings file (written by older versions,
// or by hand). Anything that isn't a valid value falls back to the default, so a job never reaches the engine
// with options it would refuse (an unknown output name, a stride past the window) and the settings file can
// never stop the app from starting.
import { isAbsolute } from "node:path";
import {
  DEFAULT_APPEARANCE,
  DEFAULT_OPTIONS,
  LINEAR_RANGES,
  MODEL_SCALES,
  OUTPUT_NAMES,
  VRAM_LIMIT_MAX_GB,
  VRAM_LIMIT_MIN_GB,
  videoCodecsFor,
  withCutoutAlpha,
  type Appearance,
  type JobOptions,
  type MemoryChoice,
  type ModelScale,
  type OutputName,
} from "../../src/shared/types";

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const num = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback);
const pathOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** A string id, or null. */
export const idArg = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null);

/** An absolute path, or null. */
export const pathArg = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && isAbsolute(v) ? v : null);

/** A Console line: a string of at most `max` characters without NUL (anything else: null, refused). */
export const consoleLineArg = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max && !v.includes("\0") ? v : null);

/** A cursor position within `line`, or null. */
export const cursorArg = (v: unknown, line: string): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= line.length ? v : null);

/**
 * The message comes from the app's own page: its window's top frame, never an embedded frame or another window. The
 * Console's channels run commands, so they check this on top of the sandbox.
 */
export function fromAppPage(e: { sender: unknown; senderFrame?: unknown }, appContents: { mainFrame: unknown } | null | undefined): boolean {
  return !!appContents && e.sender === appContents && !!e.senderFrame && e.senderFrame === appContents.mainFrame;
}

/** Dropped paths: the strings of an array (anything else: none). */
// loop: NOT-WORTH — the dropped paths, once per drop
export const pathsArg = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === "string" && p.length > 0) : []);

function memory(v: unknown): MemoryChoice {
  const m = obj(v);
  if (m.auto !== false) return { auto: true };
  const chunk = num(m.hannChunk, 1, 1000, NaN);
  const stride = num(m.hannStride, 1, 1000, NaN);
  // whole numbers, and a stride within the window (the engine refuses a gap between windows)
  if (!Number.isInteger(chunk) || !Number.isInteger(stride) || stride > chunk) return { auto: true };
  return { auto: false, hannChunk: chunk, hannStride: stride, lowVram: bool(m.lowVram, false) };
}

/** A graphics memory limit in whole GiB within the menus' range, else null (Auto). */
export function vramLimit(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= VRAM_LIMIT_MIN_GB && v <= VRAM_LIMIT_MAX_GB ? v : null;
}

/** Job options from the page or the settings file: each field valid, else its default. */
export function sanitizeOptions(v: unknown, platform: string = process.platform): JobOptions {
  const o = obj(v);
  // loop: NOT-WORTH — ≤ four output names
  const outputs = Array.isArray(o.outputs) ? OUTPUT_NAMES.filter((n) => (o.outputs as unknown[]).includes(n)) : [];
  return withCutoutAlpha({
    hintMode: oneOf(o.hintMode, ["none", "first-frame", "video"] as const, DEFAULT_OPTIONS.hintMode),
    hintFirstFrame: pathOrNull(o.hintFirstFrame),
    hintVideo: pathOrNull(o.hintVideo),
    hintQuality: num(o.hintQuality, 0, 1, DEFAULT_OPTIONS.hintQuality),
    carryHint: bool(o.carryHint, DEFAULT_OPTIONS.carryHint),
    memory: memory(o.memory),
    outputs: outputs.length ? (outputs as OutputName[]) : [...DEFAULT_OPTIONS.outputs],
    outputFormat: oneOf(o.outputFormat, ["video", "exr"] as const, DEFAULT_OPTIONS.outputFormat),
    // only what this platform offers (the Mac: lossless H.264 for now)
    videoCodec: oneOf(o.videoCodec, videoCodecsFor(platform), DEFAULT_OPTIONS.videoCodec),
    exrDtype: oneOf(o.exrDtype, ["half", "float"] as const, DEFAULT_OPTIONS.exrDtype),
    despillStrength: num(o.despillStrength, 0, 1, DEFAULT_OPTIONS.despillStrength),
    cutoutLinear: bool(o.cutoutLinear, DEFAULT_OPTIONS.cutoutLinear),
    frameDirFps: num(o.frameDirFps, 0.001, 1000, DEFAULT_OPTIONS.frameDirFps),
    frameDirLinear: bool(o.frameDirLinear, DEFAULT_OPTIONS.frameDirLinear),
    vramLimitGb: vramLimit(o.vramLimitGb),
    modelScale: (MODEL_SCALES as readonly unknown[]).includes(o.modelScale) ? (o.modelScale as ModelScale) : DEFAULT_OPTIONS.modelScale,
    linearBrightness: num(o.linearBrightness, LINEAR_RANGES.brightness[0], LINEAR_RANGES.brightness[1], DEFAULT_OPTIONS.linearBrightness),
    linearContrast: num(o.linearContrast, LINEAR_RANGES.contrast[0], LINEAR_RANGES.contrast[1], DEFAULT_OPTIONS.linearContrast),
    linearContrastPivot: num(o.linearContrastPivot, LINEAR_RANGES.pivot[0], LINEAR_RANGES.pivot[1], DEFAULT_OPTIONS.linearContrastPivot),
    deepInput: bool(o.deepInput, DEFAULT_OPTIONS.deepInput),
  });
}

/** The appearance from the page or the settings file. */
export function sanitizeAppearance(v: unknown): Appearance {
  const a = obj(v);
  return {
    theme: oneOf(a.theme, ["system", "light", "dark", "desktop"] as const, DEFAULT_APPEARANCE.theme),
    accent: oneOf(a.accent, ["builtin", "desktop"] as const, DEFAULT_APPEARANCE.accent),
    glass: bool(a.glass, DEFAULT_APPEARANCE.glass),
  };
}

/**
 * The output folder for a clip: `wanted`, unless another clip in the queue already writes there (two clips with
 * the same name: shot.mp4 and shot.mov side by side, or same-named clips from different folders when every
 * result goes into one folder). Their files have the same names too (<clip>_alpha.mp4), so the second job
 * overwrote the first one's results. Then `wanted-2`, `wanted-3`… The same clip added again keeps its folder.
 */
export function uniqueOutputDir(wanted: string, clipPath: string, jobs: readonly { outputDir: string; clip: { path: string } }[]): string {
  const taken = (dir: string) =>
    // loop: NOT-WORTH — the queue's jobs, once per candidate folder of an added clip
    jobs.some((j) => j.outputDir === dir && j.clip.path !== clipPath);
  let dir = wanted;
  // loop: NOT-WORTH — one step per same-named clip already queued [bounded: the queue's length]
  for (let n = 2; taken(dir); n++) dir = `${wanted}-${n}`;
  return dir;
}
