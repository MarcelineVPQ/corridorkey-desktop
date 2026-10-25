import type { DesktopPalette } from "../ui/theme/palette";

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
};

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

// the manual window choices (Graphics memory → Manual): what the picker offers and the estimate asks the engine about
export const MANUAL_WINDOWS: readonly (readonly [number, number])[] = [
  [80, 40],
  [48, 24],
  [24, 12],
  [8, 4],
  [4, 2],
  [1, 1],
];

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
  startedAt: number | null;
  finishedAt: number | null;
  outputs: string[];
  // ck-media: URLs of result stills (middle frame), per output.
  stills: { output: OutputName; url: string }[];
  error: JobError | null;
  // a failed / cancelled job: what happened to the files it had started (removed, or why not); null otherwise
  partial: string | null;
  log: string[];
  // the log's full length: a state push carries only its last LOG_SHOWN lines (the job keeps them all)
  logLines?: number;
}

export interface Pong {
  version: string;
  protocol: number;
  engine: string;
  device: string;
  gpu: string | null;
  vramTotalMb: number | null;
  // the PyTorch engine
  python: string | null;
  torch: string | null;
  // the Rust engine (ONNX Runtime): its version, provider (cuda / cpu) and precision (fp16 / fp32)
  ort: string | null;
  provider: string | null;
  precision: string | null;
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
  // The CorridorKey2.0 checkout: corridorkey/, weights/, vfms/, venv/.
  corridorKeyRoot: string | null;
  lastOptions: JobOptions;
  appearance: Appearance;
  // null: results go next to each clip (out_<clip>); else into this folder
  outputRoot: string | null;
  // The Rust engine (ONNX Runtime): its program, the models folder, and ONNX Runtime's library for the
  // GPU build. null = Automatic (the newest found, engineFind.ts). Set up = the engine the queue uses.
  engineBinary: string | null;
  modelsDir: string | null;
  ortLibrary: string | null;
  // run jobs on TensorRT (the Rust engine, Linux; off by default): sent to the engine only once its parts are installed
  tensorrt: boolean;
  // the graphics memory limit new clips start with (GiB; null = Auto), backlog row 43
  vramLimitGb: number | null;
  // the cache folder's parent chosen in App settings, Storage (the app keeps its own folder inside it); null = the
  // system's cache folder (platform.ts appDirs), backlog row 44
  cacheRoot: string | null;
}

export type EngineKind = "rust" | "python";

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
  notes: string | null;
  progress: number | null;
  error: string | null;
  checkedAt: number | null;
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
  // each part's download size (shown before the start)
  runtimeBytes: number;
  modelsBytes: number;
  // the system can run the engine on its graphics hardware (an NVIDIA driver; Apple Silicon on macOS), else why not
  gpuOk: boolean;
  gpuProblem: string | null;
  // the runtime download, as the setup page describes it (CUDA libraries, or Core ML on macOS)
  runtimeWhat: string;
  status: InstallStatus;
  step: string | null;
  done: number;
  total: number;
  error: string | null;
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
  // per clip in the queue: its thumbnail and result stills, and its job's working files while it runs
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
  checkout: CheckoutCheck;
  // the Rust engine's setup, and which engine the queue uses (null: none is set up)
  rustEngine: CheckoutCheck;
  engineKind: EngineKind | null;
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
  // this system's file names, for the Engine page's hints (electron/main/platform.ts)
  system: { engineBin: string; ortLib: string; platform: string };
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
  pickCheckout(): Promise<void>;
  pickRustEngine(what: EngineFileKind): Promise<void>;
  // null = Automatic; a path must be one the list offers (or the current setting)
  setRustEngine(what: EngineFileKind, path: string | null): Promise<void>;
  installFfmpeg(): Promise<void>;
  // "tensorrt": the opt-in TensorRT parts (once the runtime and models are installed); else the runtime and models
  startInstall(part?: "tensorrt"): Promise<void>;
  stopInstall(): Promise<void>;
  // the TensorRT setting (Linux; ignored elsewhere)
  setTensorrt(on: boolean): Promise<void>;
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
}
