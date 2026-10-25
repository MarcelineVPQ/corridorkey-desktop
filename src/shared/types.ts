import type { DesktopPalette } from "../ui/theme/palette";

// Types shared by the main process, the preload and the page. The engine's
// own messages are in docs/ENGINE_PROTOCOL.md; these are the app's view of them.

export type OutputName = "alpha" | "fg" | "checker" | "cutout";
export const OUTPUT_NAMES: OutputName[] = ["alpha", "fg", "checker", "cutout"];

export type HintMode = "none" | "first-frame" | "video";

export type MemoryChoice = { auto: true } | { auto: false; hannChunk: number; hannStride: number; lowVram: boolean };

export interface JobOptions {
  hintMode: HintMode;
  hintFirstFrame: string | null;
  hintVideo: string | null;
  hintQuality: number;
  carryHint: boolean;
  memory: MemoryChoice;
  outputs: OutputName[];
  outputFormat: "video" | "exr";
  exrDtype: "half" | "float";
  despillStrength: number;
  cutoutLinear: boolean;
  frameDirFps: number;
  frameDirLinear: boolean;
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
  exrDtype: "half",
  despillStrength: 0.5,
  cutoutLinear: false,
  frameDirFps: 24,
  frameDirLinear: false,
};

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
