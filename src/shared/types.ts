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

export interface ClipInfo {
  path: string;
  name: string;
  kind: "video" | "frames";
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

export interface JobError {
  code: string;
  message: string;
  stderrTail: string[];
}

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
  log: string[];
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
  // GPU build (null: the engine finds its own). Set up = the engine the queue uses.
  engineBinary: string | null;
  modelsDir: string | null;
  ortLibrary: string | null;
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
  // the desktop's colors (Desktop theme / desktop accent); null = couldn't be read or not asked
  desktopPalette: DesktopPalette | null;
  update: UpdateState;
}

export interface CorridorKeyApi {
  getState(): Promise<AppState>;
  onState(listener: (state: AppState) => void): () => void;
  addPaths(paths: string[]): Promise<void>;
  pickClips(): Promise<void>;
  pickFile(kind: "hint-image" | "hint-video"): Promise<string | null>;
  pickCheckout(): Promise<void>;
  pickRustEngine(what: "binary" | "models" | "ort"): Promise<void>;
  pathForFile(file: File): string;
  setJobOptions(id: string, options: JobOptions): Promise<void>;
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
