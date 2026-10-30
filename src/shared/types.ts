import type { DesktopPalette } from "../ui/theme/palette";
import type { TrtSize } from "./trt";

// Types shared by the main process, the preload and the page. The engine's
// own messages are in docs/ENGINE_PROTOCOL.md; these are the app's view of them.

export type OutputName = "alpha" | "fg" | "checker" | "cutout";
export const OUTPUT_NAMES: OutputName[] = ["alpha", "fg", "checker", "cutout"];

export type HintMode = "none" | "first-frame" | "video";

export type MemoryChoice = { auto: true } | { auto: false; hannChunk: number; hannStride: number; lowVram: boolean };

// The video outputs' codec (the engine's `video_codec`, docs/ENGINE_PROTOCOL.md; backlog row 26). None carries alpha.
export type VideoCodec = "h264-lossless" | "dnxhr444" | "h264-crf12";
export const VIDEO_CODECS: VideoCodec[] = ["h264-lossless", "dnxhr444", "h264-crf12"];

/** The codecs offered on a platform: all three on Linux and Windows; the Mac has lossless H.264 until Apple's ProRes 4444 XQ (VideoToolbox) comes with the Mac work. */
export function videoCodecsFor(platform: string): VideoCodec[] {
  return platform === "darwin" ? ["h264-lossless"] : VIDEO_CODECS;
}

export interface JobOptions {
  hintMode: HintMode;
  hintFirstFrame: string | null;
  hintVideo: string | null;
  hintQuality: number;
  carryHint: boolean;
  memory: MemoryChoice;
  outputs: OutputName[];
  outputFormat: "video" | "exr";
  videoCodec: VideoCodec;
  exrDtype: "half" | "float";
  despillStrength: number;
  cutoutLinear: boolean;
  frameDirFps: number;
  frameDirLinear: boolean;
  // Graphics memory limit (backlog row 43): the engine's `vram_budget_gb` in GiB; null = Auto (VRAM_LIMIT_AUTO_HELP)
  vramLimitGb: number | null;
  // the networks' internal resolution (the engine's `model_scale`, backlog row 42): 1 = full
  modelScale: ModelScale;
  // the scene-linear exposure adjust for video clips (`linear_brightness` / `linear_contrast` / `linear_contrast_pivot`, row 45)
  linearBrightness: number;
  linearContrast: number;
  linearContrastPivot: number;
  // read 10/12-bit video and 16-bit PNG at 16 bits (the engine's `input_bit_depth` "16", backlog row 27); off = CorridorKey 2.0's own 8-bit read
  deepInput: boolean;
}

export const DEFAULT_OPTIONS: JobOptions = {
  hintMode: "none",
  hintFirstFrame: null,
  hintVideo: null,
  hintQuality: 0.95,
  carryHint: true,
  memory: { auto: true },
  outputs: ["alpha", "fg"],
  outputFormat: "video",
  videoCodec: "h264-lossless",
  exrDtype: "half",
  despillStrength: 0.5,
  cutoutLinear: false,
  frameDirFps: 24,
  frameDirLinear: false,
  vramLimitGb: null,
  modelScale: 1,
  linearBrightness: 1,
  linearContrast: 1,
  linearContrastPivot: 0.18,
  deepInput: false,
};

// Internal resolution: the plugin's Full / ¾ / ½ / ¼ (the original's --model_scale takes any value above 0)
export type ModelScale = 1 | 0.75 | 0.5 | 0.25;
export const MODEL_SCALES: ModelScale[] = [1, 0.75, 0.5, 0.25];

// the linear adjust's ranges in the app (the original has none; the engine refuses 0 and below for brightness and contrast)
export const LINEAR_RANGES = { brightness: [0.25, 4], contrast: [0.5, 2], pivot: [0.01, 1] } as const;

// a frame folder's frame rate: what the field takes and what sanitizeOptions keeps (validate.ts; tied in validate.test.ts)
export const FRAME_DIR_FPS_RANGE = [0.001, 1000] as const;

/** The frame-rate field's text as a rate it takes, else null (empty, half-typed or out of range: the field keeps it). */
export function frameRateOf(text: string): number | null {
  const n = Number(text);
  return text.trim() !== "" && Number.isFinite(n) && n >= FRAME_DIR_FPS_RANGE[0] && n <= FRAME_DIR_FPS_RANGE[1] ? n : null;
}

/** video_io.scaled_hw: each side × the scale, Python's round (half to even), at least 1. */
export function scaledSize(n: number, scale: number): number {
  const x = n * scale;
  const f = Math.floor(x);
  const r = x - f === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(x);
  return Math.max(1, r);
}

// the graphics memory limit's range (GiB): whole numbers, as the menus offer them
export const VRAM_LIMIT_MIN_GB = 2;
export const VRAM_LIMIT_MAX_GB = 256;
// the menu when the card's size hasn't been read yet
const VRAM_LIMIT_UNREAD: readonly number[] = [2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 32, 48];

/** What "Auto" means (engine-rs pipeline run_job, vram.rs select_vram_profile, ENGINE_PROTOCOL.md `vram_budget_gb`). */
export const VRAM_LIMIT_AUTO_HELP =
  "Auto sends no limit: the engine's budget is the memory free on the card when the job starts (plus what it already holds; " +
  "CK_ENGINE_VRAM_BUDGET_GB caps it when that is set), and the automatic window is the largest whose peak estimate × 1.1 + 0.3 GiB fits it. " +
  "A limit caps that budget: the automatic window is chosen within the smaller of the free memory and the limit, and on CUDA each network's memory pool is capped at it. " +
  "A manual window is never resized, so one past the limit can run out of memory. Not used on the CPU or on Apple Silicon (Core ML takes its window from the model set).";

/** The limit menu's whole GiB: 2 up to the card's size when it has been read (the engine's or the driver's total), else a fixed set; `current` always kept. */
export function vramLimitChoices(totalBytes: number | null, current: number | null): number[] {
  const top = totalBytes !== null && totalBytes > 0 ? Math.floor(totalBytes / 1073741824) : null;
  // loop: NOT-WORTH — at most VRAM_LIMIT_MAX_GB numbers, per render of the limit menu
  const base = top !== null && top >= VRAM_LIMIT_MIN_GB ? Array.from({ length: Math.min(top, VRAM_LIMIT_MAX_GB) - VRAM_LIMIT_MIN_GB + 1 }, (_, i) => VRAM_LIMIT_MIN_GB + i) : [...VRAM_LIMIT_UNREAD];
  if (current !== null && !base.includes(current)) base.push(current);
  // loop: NOT-WORTH — as above
  return base.sort((a, b) => a - b);
}

/** A video cutout is premultiplied colour without an alpha channel (no video codec here carries one): its alpha is the Alpha output, so a video job with a cutout always writes it (the engine adds it too). */
export function withCutoutAlpha(o: JobOptions): JobOptions {
  if (o.outputFormat !== "video" || !o.outputs.includes("cutout") || o.outputs.includes("alpha")) return o;
  // loop: NOT-WORTH — four output names
  return { ...o, outputs: OUTPUT_NAMES.filter((x) => x === "alpha" || o.outputs.includes(x)) };
}

// a video file, or a folder of frames (a frame sequence)
export type ClipKind = "video" | "frames";

export interface ClipInfo {
  path: string;
  name: string;
  kind: ClipKind;
  width: number | null;
  height: number | null;
  fps: number | null;
  frames: number | null;
  // ck-media: URL of a small still, or null while it is made / when it failed.
  thumb: string | null;
  // Companion hints found next to the clip (run_interactive.py's naming).
  companionFirstFrame: string | null;
  companionHintVideo: string | null;
  // a frame folder whose first frame (in the engine's order) is OpenEXR: the corridorkey CLI reads it scene-linear by
  // default, so Copy as command and farm export write --linear or --no-linear for it (jobCommand.ts)
  exrFrames: boolean;
  probeError: string | null;
}

export type JobStatus = "waiting" | "running" | "done" | "failed" | "cancelled";
export type Stage = "start" | "load" | "optimize" | "probe" | "rvm" | "foundations" | "keying";

export interface MemoryInfo {
  hannChunk: number;
  hannStride: number;
  lowVram: boolean;
  auto: boolean;
  budgetGb: number | null;
  estimateGb: number | null;
  // the free memory the engine read (plus its own), and the job's graphics memory limit (`budget_cap_gb`), GiB
  freeGb: number | null;
  limitGb: number | null;
}

// What ran the job (the engine's `provider` reply, docs/ENGINE_PROTOCOL.md), plus why the app didn't ask for
// TensorRT when it didn't (the app's own decision at the job's start: the setting, the parts, the engine).
export interface JobTech {
  // cuda | tensorrt | tensorrt+cuda | cpu | coreml (null: the engine sent no provider reply)
  provider: string | null;
  precision: string | null;
  tensorrtRequested: boolean;
  // the engine's reason a requested TensorRT ran on CUDA (`fallback_reason`)
  fallbackReason: string | null;
  // networks TensorRT couldn't take, and why (`fallbacks`: stage1 → "no tactic …")
  fallbacks: Record<string, string>;
  // the TensorRT engine range (`range`) and whether it was built for this job (`cache`: build | reused)
  range: string | null;
  cache: string | null;
  // the app didn't ask for TensorRT: why (null when it asked, or where TensorRT doesn't exist: Windows, macOS)
  notAsked: string | null;
  // the model set the engine had loaded when the job started (its pong): version and folder; null when not reported
  modelSet: string | null;
  modelsDir: string | null;
}

// the manual window choices (Graphics memory → Manual): what the picker offers and the estimate asks the engine about
export const MANUAL_WINDOWS: readonly (readonly [number, number])[] = [
  [80, 40],
  [48, 24],
  [24, 12],
  [8, 4],
  [4, 2],
  [1, 1],
];

/** The picker's windows: MANUAL_WINDOWS, plus the clip's own window when it isn't one of them (a settings file's, a
 * farm line's), so the picker shows what is set instead of a blank. */
export function windowChoices(chunk: number, stride: number): (readonly [number, number])[] {
  // loop: NOT-WORTH — six windows, per render of the Manual picker
  return MANUAL_WINDOWS.some(([c, s]) => c === chunk && s === stride) ? [...MANUAL_WINDOWS] : [...MANUAL_WINDOWS, [chunk, stride] as const];
}

// One window's graphics-memory estimate, as the engine's `estimate` reply gives it (docs/ENGINE_PROTOCOL.md, backlog row 41).
export interface WindowEstimate {
  hannChunk: number;
  hannStride: number;
  lowVram: boolean;
  // the engine's peak estimate (the automatic window's own), and what it requires of the budget with its margin
  peakBytes: number;
  needsBytes: number;
  // null: no memory reading (no verdict)
  fits: boolean | null;
}

export interface MemoryEstimate {
  width: number;
  height: number;
  frames: number;
  totalBytes: number | null;
  freeBytes: number | null;
  // what the windows are weighed against: the free memory, or less under a configured cap
  budgetBytes: number | null;
  // the limit the budget was capped by (the request's `vram_budget_gb`, else the engine's CK_ENGINE_VRAM_BUDGET_GB), GiB
  capGb: number | null;
  // what the reading came from: cuda / tensorrt / cpu / coreml (null: no reading)
  provider: string | null;
  windows: WindowEstimate[];
  // when the engine read it (ms since the epoch)
  at: number;
}

// `stale`: read before the queue started (the engine is busy keying, so it isn't asked again until the queue ends)
export type MemoryEstimateResult = { ok: true; estimate: MemoryEstimate; stale: boolean } | { ok: false; reason: string };

export interface JobError {
  code: string;
  message: string;
  stderrTail: string[];
}

// the engine-log lines the page shows per job (and all a state push carries)
export const LOG_SHOWN = 12;
// the engine-log lines a job keeps for its saved log and Copy log (backlog row 55): a job logs tens to hundreds of
// lines; a runaway log is cut from its start, and the file says how many lines went
export const LOG_KEPT = 20_000;

export interface Job {
  id: string;
  clip: ClipInfo;
  options: JobOptions;
  outputDir: string;
  status: JobStatus;
  stage: Stage | null;
  stageDetail: string | null;
  framesDone: number;
  framesTotal: number | null;
  // Measured from the frames written so far (null until there are enough).
  framesPerSecond: number | null;
  memory: MemoryInfo | null;
  // what ran it (set when the job starts; absent on jobs from before this field)
  tech?: JobTech | null;
  startedAt: number | null;
  finishedAt: number | null;
  outputs: string[];
  // ck-media: URLs of result stills (middle frame), per output.
  stills: { output: OutputName; url: string }[];
  error: JobError | null;
  // a failed / cancelled job: what happened to the files it had started (removed, or why not); null otherwise
  partial: string | null;
  log: string[];
  // the log's full length: a state push carries only its last LOG_SHOWN lines (the job keeps up to LOG_KEPT)
  logLines?: number;
  // lines dropped from the start of a log longer than LOG_KEPT (the saved file says so)
  logDropped?: number;
  // the whole log saved next to the results as <clip>_log.txt when the job ended (backlog row 55), or why it couldn't be
  logSaved?: { path: string; error: string | null } | null;
  // the corridorkey line the queue ran it as (src/shared/console/jobCommand.ts), set when it starts; the Console echoes it
  // (null: a path has characters a shell would read, so there is no safe line)
  command?: string | null;
}

export interface Pong {
  version: string;
  protocol: number;
  engine: string;
  device: string;
  gpu: string | null;
  vramTotalMb: number | null;
  // ONNX Runtime: its version, provider (cuda / cpu) and precision (fp16 / fp32)
  ort: string | null;
  provider: string | null;
  precision: string | null;
  // the model set the engine loaded: its folder and its manifest's version ("2.0.0-onnx.5"); null when not sent
  modelsDir: string | null;
  modelSet: string | null;
  assets: Record<string, boolean>;
}

export type EngineStatus = "stopped" | "starting" | "ready" | "failed";

export interface EngineState {
  status: EngineStatus;
  pong: Pong | null;
  error: string | null;
}

export interface GpuProcess {
  pid: number;
  name: string;
  usedMb: number;
  ours: boolean;
}

export interface GpuInfo {
  name: string;
  totalMb: number;
  usedMb: number;
  utilization: number;
  // NorthXL's GPU card readings (backlog row 171); left out (never 0) where the card or driver doesn't give one
  tempC?: number;
  fanPct?: number;
  clockMhz?: number;
  powerW?: number;
  processes: GpuProcess[];
  at: number;
}

export type ThemeMode = "system" | "light" | "dark" | "desktop";

export interface Appearance {
  // system: the OS light/dark; desktop: the desktop's own colors (KDE scheme or accent)
  theme: ThemeMode;
  // the accent in the built-in themes: CorridorKey green, or the desktop's accent
  accent: "builtin" | "desktop";
  // Liquid Glass on the rail and panels
  glass: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: "system", accent: "builtin", glass: false };

export interface Settings {
  lastOptions: JobOptions;
  appearance: Appearance;
  // null: results go next to each clip (out_<clip>); else into this folder
  outputRoot: string | null;
  // The Rust engine (ONNX Runtime): its program, the models folder, and ONNX Runtime's library for the
  // GPU build. null = Automatic (the newest found, engineFind.ts). Set up = the engine the queue uses.
  engineBinary: string | null;
  modelsDir: string | null;
  ortLibrary: string | null;
  // the model set the setup installs and Automatic runs (Engine settings, ONNX Runtime engine, "Model set"; backlog
  // row 168): install.ts MODEL_SETS, the default when unknown
  modelSet: string;
  // run jobs on TensorRT (the Rust engine, Linux; off by default): sent to the engine only once its parts are installed
  tensorrt: boolean;
  // the graphics memory limit new clips start with (GiB; null = Auto), backlog row 43
  vramLimitGb: number | null;
  // the sizes TensorRT builds for in the background (Engine settings, TensorRT; backlog row 56), one per range
  trtSizes: TrtSize[];
  // the cache folder's parent chosen in App settings, Storage (the app keeps its own folder inside it); null = the
  // system's cache folder (platform.ts appDirs), backlog row 44
  cacheRoot: string | null;
  // the folders the Console may also write to (its `allow` command, after a confirmation; App settings, Console
  // removes them), absolute; docs/CONSOLE.md "File scope"
  consoleWriteFolders: string[];
  // the Console's bookmarks (`bookmark sh010`, `cd @sh010`): name → absolute folder; docs/CONSOLE.md "Bookmarks"
  consoleBookmarks: Record<string, string>;
  // the Console's kept variables (`set -p name=value`; `${name}` in a line): name → value; docs/CONSOLE.md "Variables"
  consoleVariables: Record<string, string>;
}

// The app's own updates (electron/main/updater). null feed = no release
// channel set up yet (the repo has no releases): App settings says so.
export type UpdateChannel = "stable" | "dev";
export interface UpdateState {
  feed: string | null;
  channel: UpdateChannel;
  automatic: boolean;
  status: "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "error" | "unsupported";
  current: string;
  latest: string | null;
  // the offered download's size in bytes (from the signed feed), while one is offered
  size: number | null;
  notes: string | null;
  progress: number | null;
  error: string | null;
  // what failed: a check (said in App settings, Updates; a scheduled one stays quiet there only) or the install the user
  // started (also pinned above the page until dismissed: UpdateBanner.tsx)
  errorFrom: "check" | "install" | null;
  checkedAt: number | null;
  // Windows and macOS (backlog row 180): Download opens the offered version's release page on GitHub; nothing installs
  opensPage: boolean;
}

// The Rust engine's files found on this computer (electron/main/engineFind.ts), newest first.
export interface EngineFileChoice {
  path: string;
  label: string;
}
export interface EngineFiles {
  binary: EngineFileChoice[];
  models: EngineFileChoice[];
  ort: EngineFileChoice[];
}
// one of the engine's files: its program, the models folder, ONNX Runtime's library (an Engine-page list each)
export type EngineFileKind = keyof EngineFiles;

// An install's state (the runtime and models, TensorRT's parts): waiting, downloading, or stopped by an error.
export type InstallStatus = "idle" | "running" | "error";

// The first-run install (electron/main/install.ts): the GPU runtime and the models into the data folder.
export interface InstallState {
  // where it installs (the data folder: $XDG_DATA_HOME, %LOCALAPPDATA% or Application Support/corridorkey-desktop)
  dir: string;
  // what is missing, and its download size in bytes
  needRuntime: boolean;
  needModels: boolean;
  bytes: number;
  // each part's download size, what is still missing (shown before the start; the models include the Core ML set on macOS)
  runtimeBytes: number;
  modelsBytes: number;
  // the system can run the engine on its graphics hardware (an NVIDIA driver; Apple Silicon on macOS), else why not
  gpuOk: boolean;
  gpuProblem: string | null;
  // the runtime download, as the setup page describes it (CUDA libraries, or Core ML on macOS)
  runtimeWhat: string;
  // an AMD card is set up (Linux, no NVIDIA driver; amd.ts): the setup and Engine page say AMD is untested on a real card
  amd: boolean;
  // the model sets this system offers (the default first): each installed, or its download size (backlog row 168)
  modelSets: ModelSetChoice[];
  status: InstallStatus;
  step: string | null;
  done: number;
  total: number;
  error: string | null;
}

/** A model set Engine settings offers (install.ts modelSetChoices). */
export interface ModelSetChoice {
  name: string;
  installed: boolean;
  // its download (with the Core ML set on macOS)
  bytes: number;
}

// The opt-in TensorRT parts (electron/main/install.ts, after "TensorRT"): NVIDIA's libraries, ONNX Runtime's
// TensorRT provider, the TensorRT models; installed on top of the runtime and models.
export interface TrtState {
  // Linux in 1.0: Windows needs its own engine builder (later), macOS has no TensorRT
  supported: boolean;
  // the setting
  on: boolean;
  // the parts are there for the files the engine runs with: only then does a job ask for TensorRT
  ready: boolean;
  needLibs: boolean;
  needProvider: boolean;
  needModels: boolean;
  // what is still to download, and the whole TensorRT download on a fresh install (the hint)
  bytes: number;
  fullBytes: number;
  status: InstallStatus;
  step: string | null;
  done: number;
  total: number;
  error: string | null;
  // the TensorRT ranges built for this card (engine range keys, "h1792-2176_w3584-4096_t1-8_f1-4"), read from the cache
  built: string[];
  // the background build of the chosen sizes (trtPrebuild.ts): jobs never build, they run on CUDA until it's done
  prebuild: TrtPrebuild;
  // each range built on this card: its size on disk (read from the cache) and how long its build took here (recorded
  // when the app built it; null: built before this was recorded, or by a job); `stale`: built for other model files
  // (the model set changed), so the engine doesn't use it until it is built again
  onDisk: { range: string; bytes: number; buildSeconds: number | null; stale: boolean }[];
}

/** Another program holding this much graphics memory is named before a run, and holds back the background TensorRT
 * build (desktops and browsers hold less; the engine bench refuses to start above 1 GiB, tools/engine_bench.mjs). */
export const OTHER_GPU_USER_MB = 512;

export type PrebuildStatus = "idle" | "running" | "paused" | "done" | "stopped" | "blocked" | "error";

export interface PrebuildRange {
  // the size's name ("4K DCI", "HD", a clip's name, "Your size") and the size built for
  label: string;
  width: number;
  height: number;
  state: "todo" | "building" | "done" | "failed";
  // the network being built (cradio, moge, rvm, stage1, stage2)
  piece: string | null;
  // the engine's range key once known, and networks that couldn't be built (they run on CUDA)
  range: string | null;
  fallbacks: Record<string, string>;
  error: string | null;
  // a build that ran short of memory while no other program used the card: building again isn't offered
  cardWasFree?: boolean;
}

export interface TrtPrebuild {
  status: PrebuildStatus;
  ranges: PrebuildRange[];
  // when this run started (the elapsed clock), null when not running
  startedAt: number | null;
  // what it waits for, why it stopped, or the error
  note: string | null;
}

// What the app keeps on disk (electron/main/storage.ts), measured when App settings shows Storage.
export interface StorageItem {
  id: "runtime" | "models" | "tensorrt" | "cache";
  label: string;
  path: string;
  bytes: number;
}

// The cache folder (backlog row 44), measured with Storage: where it is, and what is in it per clip and per TensorRT range.
export interface CacheInfo {
  dir: string;
  // the system's cache folder (Default), and whether the cache is there
  defaultDir: string;
  isDefault: boolean;
  bytes: number;
  // per clip in the queue: its thumbnail and result stills, and its job's working files while it runs (in the system's folder)
  shots: { name: string; bytes: number }[];
  // stills of clips no longer in the queue (pruned at start: 30 days, 500 MB)
  otherBytes: number;
  // the TensorRT engines built for this card, per resolution range (Linux)
  trtRanges: { range: string; bytes: number }[];
  // a move or a fresh start in progress, or why the last one stopped
  moving: string | null;
  error: string | null;
}

// The card's memory as the engine last read it (an `estimate` reply), for the limit menus.
export interface CardReading {
  totalBytes: number | null;
  freeBytes: number | null;
  at: number;
}

// The system's ffmpeg (electron/main/ffmpeg.ts): ok = ffmpeg + ffprobe with the encoders the engine writes with.
export interface FfmpegState {
  // false until the first check has answered (the page says "Checking", never "installed", before that)
  checked: boolean;
  ok: boolean;
  problem: string | null;
  // the install for this distro, to read or copy; canInstall = the app can run it (pkexec), else `note` says what first
  command: string;
  canInstall: boolean;
  // what the install button's hint says (Linux: the desktop's password prompt; Windows: winget; macOS: Homebrew)
  runHint: string;
  note: string | null;
  installing: boolean;
  installError: string | null;
}

export interface CheckoutCheck {
  ok: boolean;
  problems: string[];
}

export interface AppState {
  version: string;
  jobs: Job[];
  queueRunning: boolean;
  engine: EngineState;
  gpu: GpuInfo | null;
  gpuError: string | null;
  settings: Settings;
  // the Rust engine's setup (ok: the queue can run)
  rustEngine: CheckoutCheck;
  // what the Engine page's lists offer, and the paths the engine runs with (a setting of null = Automatic)
  engineFiles: EngineFiles;
  ffmpeg: FfmpegState;
  install: InstallState;
  tensorrt: TrtState;
  // null until App settings asks for it (measuring walks the folders)
  storage: StorageItem[] | null;
  // the cache folder, measured with Storage (null until then)
  cache: CacheInfo | null;
  // the chosen cache folder's drive isn't there (why; null: fine): the cache is in the system's folder for now
  cacheMissing: string | null;
  // the card's memory from the engine's last estimate (null: not read yet)
  card: CardReading | null;
  enginePaths: Record<EngineFileKind, string | null>;
  // the desktop's colors (Desktop theme / desktop accent); null = couldn't be read or not asked
  desktopPalette: DesktopPalette | null;
  update: UpdateState;
  // why the restart into an update must wait now (electron/main/busy.ts restartRefusal), or null: it can go
  restartWait: string | null;
  // this system's file names, for the Engine page's hints (electron/main/platform.ts)
  // and the home folder, shown as ~ in shortened paths (src/ui/paths.ts)
  system: { engineBin: string; ortLib: string; platform: string; home: string };
  // the Console's session (electron/main/console; its output blocks come on their own channel: onConsoleBlocks)
  console: ConsoleSession;
}

// The Console (backlog row 95, docs/CONSOLE.md). The main process runs every command; the page shows these.
export interface ConsoleSession {
  // the Console's current folder (cd)
  cwd: string;
  // elevated (sudo) until this time (ms since the epoch); null: not elevated
  elevatedUntil: number | null;
  // the line of the command running now (one at a time), or null
  running: string | null;
  // the corridorkey command line ships with this copy (render, verify, prepare, info need it)
  cliFound: boolean;
  // the network servers (\\server\…) the Console may open until the app quits: allow-server (Windows only)
  servers: string[];
  // allowed folders the settings file named that allow refuses (a root or a system folder): dropped at start, shown
  droppedFolders: string[];
}

// A line in the Console's history (electron/main/console/logs.ts): its stable number, folder and time, and how it ended
// (null: not known yet, or from before these were kept)
export interface ConsoleHistoryEntry {
  n: number;
  line: string;
  // ISO time it was typed
  time: string | null;
  cwd: string | null;
  exit: number | null;
  // the block's end state: done, failed, refused, cancelled
  state: string | null;
}

export interface ConsoleLine {
  text: string;
  // out: the command's output; err: its error stream or a refusal; info: the Console's own notes
  kind: "out" | "err" | "info";
}

// a dir / ls row
export interface ConsoleEntry {
  name: string;
  folder: boolean;
  // null: unreadable (a dangling link)
  bytes: number | null;
  modified: number | null;
  // a frame sequence's row (name is its pattern, sh010_plate.####.exr; bytes its frames'; modified the newest), else null
  // (span: frames first to last, gaps: the missing ones listed further for the hover, belowZero: frames below 0)
  sequence: { range: string; count: number; missing: string | null; span?: number; gaps?: string | null; belowZero?: number } | null;
}

// one command and everything it printed (Warp-style output block)
export interface ConsoleBlock {
  id: number;
  // the line as typed
  line: string;
  // the script block (run file.ckcmd) this line ran from, or null
  parent: number | null;
  cwd: string;
  // corridorkey's arguments as run (paths resolved, --progress-format json added), or null for a built-in
  argv: string[] | null;
  // the same as the user asked for it, without the Console's own --progress-format and --temp (Copy as farm line)
  command?: string[] | null;
  // a failed verify (exit 9): the render line for its missing frames (-F <ranges>), which Re-render missing puts in the
  // input (never runs it)
  rerender?: string | null;
  // a render that ended 0: the EXR sequences it wrote (path with ####, first and last frame there), for Copy as Nuke Read
  reads?: { path: string; first: number; last: number }[] | null;
  elevated: boolean;
  state: "running" | "done" | "failed" | "refused" | "cancelled";
  exitCode: number | null;
  // the exit code's meaning (docs/CLI.md "Exit codes")
  exitMeaning: string | null;
  startedAt: number;
  finishedAt: number | null;
  // from the CLI's own JSON events: frames handed to the writers, never an estimate
  progress: { percent: number; done: number; total: number } | null;
  // the frames per second measured over the last progress events (≤ RATE_FRAMES frames back), never an estimate
  rate?: { fps: number; frames: number } | null;
  // the CLI's phase (loading the models, keying: window 3/10 done…)
  status: string | null;
  lines: ConsoleLine[];
  // lines dropped at the front (CONSOLE_LINES_KEPT, CONSOLE_CHARS_KEPT)
  linesDropped: number;
  // in a push to the page: the number of the first of `lines` (counted from the block's first line, dropped ones
  // included); a push carries only the lines appended since the last one (mergeBlocks puts them after the page's)
  linesFrom?: number;
  entries: ConsoleEntry[] | null;
  // a refused line's mistakes, with their ranges in `line`
  errors: { message: string; start: number; end: number }[];
  // cls / clear: the page clears the screen
  clear: boolean;
  // a queue job's line, echoed (teach by echo): what started it ("the queue started sh010.mov"); never typed or run here
  echo?: string | null;
  // doctor's rows: the page shows them as a table (Copy output: as text)
  doctor?: DoctorRow[] | null;
  // its lines are a drawing (tree): never wrapped
  nowrap?: boolean;
  // absolute paths in its lines the page may show shortened (~, the middle as …), the full one on hover and in Copy
  paths?: string[] | null;
}

/** One `doctor` check: ✓ ok, ⚠ warn, ✗ fail, what it found, and for a problem the exact fix (a Console line or an App action). */
export interface DoctorRow {
  check: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix: string | null;
  // the path in its detail (the page shortens it; Copy output keeps it whole)
  path?: string | null;
}

export interface ConsoleCompletionItem {
  // the text that replaces start..end (quoted as needed)
  insert: string;
  label: string;
  kind: "command" | "flag" | "value" | "file" | "folder";
  help: string;
}

export interface ConsoleCompletion {
  start: number;
  end: number;
  items: ConsoleCompletionItem[];
}

// the hint file a dialog picks: the first-frame matte image, or the hint video (or frame folder)
export type HintFileKind = "hint-image" | "hint-video";

export interface CorridorKeyApi {
  getState(): Promise<AppState>;
  onState(listener: (state: AppState) => void): () => void;
  addPaths(paths: string[]): Promise<void>;
  // "files": video files; "folder": frame sequences and folders of clips (one dialog can't pick both)
  pickClips(kind: "files" | "folder"): Promise<void>;
  pickFile(kind: HintFileKind): Promise<string | null>;
  pickRustEngine(what: EngineFileKind): Promise<void>;
  // null = Automatic; a path must be one the list offers (or the current setting)
  setRustEngine(what: EngineFileKind, path: string | null): Promise<void>;
  installFfmpeg(): Promise<void>;
  // "tensorrt": the opt-in TensorRT parts (once the runtime and models are installed); else the runtime and models
  startInstall(part?: "tensorrt"): Promise<void>;
  stopInstall(): Promise<void>;
  // the TensorRT setting (Linux; ignored elsewhere)
  setTensorrt(on: boolean): Promise<void>;
  // the model set (one install.ts offers on this system; refused while a download runs); the Models folder goes back to Automatic
  setModelSet(name: string): Promise<void>;
  // the background TensorRT build (Engine settings, TensorRT): start it (or again), or stop it
  trtPrebuild(action: "start" | "stop"): Promise<void>;
  // choose a size to build for (it builds now), or remove one: its range's built engines are deleted (asked first)
  // or build it now from a job's TensorRT tile ("build": as Build now, also where a range of it is built for shorter windows)
  trtSize(action: "add" | "remove" | "build", size: TrtSize): Promise<void>;
  measureStorage(): Promise<void>;
  // asks for confirmation first (a system dialog); refused while the queue or the install runs
  removeStorage(id: StorageItem["id"]): Promise<void>;
  // opens a Storage folder (or the cache folder) in the file manager
  openStorageFolder(id: StorageItem["id"] | "cache-root"): Promise<void>;
  // choose the cache folder's location (a folder dialog, then: move the files or start fresh, asked); "default": back to the system's
  pickCacheFolder(to?: "default"): Promise<void>;
  // the graphics memory limit new clips start with (GiB; null = Auto)
  setVramLimitDefault(gb: number | null): Promise<void>;
  pathForFile(file: File): string;
  setJobOptions(id: string, options: JobOptions): Promise<void>;
  // the engine's graphics-memory estimate for each manual window of a waiting job's clip (backlog row 41)
  estimateMemory(id: string): Promise<MemoryEstimateResult>;
  removeJob(id: string): Promise<void>;
  retryJob(id: string): Promise<void>;
  startQueue(): Promise<void>;
  stopQueue(): Promise<void>;
  showInFolder(path: string): Promise<void>;
  // puts text (a path) on the system clipboard; false when it was refused
  copyText(text: string): Promise<boolean>;
  // puts a job's whole engine log (as its <clip>_log.txt has it) on the clipboard; false when there is no such job
  copyJobLog(id: string): Promise<boolean>;
  setAppearance(appearance: Appearance): Promise<void>;
  pickOutputRoot(): Promise<void>;
  clearOutputRoot(): Promise<void>;
  checkForUpdates(): Promise<void>;
  setUpdateChannel(channel: UpdateChannel): Promise<void>;
  setAutoUpdate(on: boolean): Promise<void>;
  installUpdate(): Promise<void>;
  restartToUpdate(): Promise<void>;
  backToStable(): Promise<void>;
  setVisible(visible: boolean): void;
  // the Console (docs/CONSOLE.md): run a typed line (the main process parses and checks it; null: refused as input)
  consoleRun(line: string): Promise<ConsoleBlock | null>;
  // Ctrl+C: the running command stops cleanly; a second one ends it at once
  // lines pasted at once (2 or more), run as a script after the page's offer (each checked as a typed line; null: refused as input)
  consoleRunLines(lines: string[]): Promise<ConsoleBlock | null>;
  consoleCancel(): Promise<void>;
  // Tab: completions for the word at the cursor
  consoleComplete(line: string, cursor: number): Promise<ConsoleCompletion>;
  // Ctrl+R and the History panel: earlier lines whose text or folder contains the query, newest first
  consoleHistory(query: string): Promise<ConsoleHistoryEntry[]>;
  // sudo -k from the panel: elevation dropped now
  consoleElevationDrop(): Promise<void>;
  // App settings → Console: the Console may no longer write in this allowed folder (false: it wasn't one)
  consoleDisallow(folder: string): Promise<boolean>;
  // block updates (a running command's output and progress), at most 10 a second, while the window is shown
  onConsoleBlocks(listener: (blocks: ConsoleBlock[]) => void): () => void;
}
