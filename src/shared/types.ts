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
export type Stage = "start" | "load" | "probe" | "rvm" | "foundations" | "keying";

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
  python: string;
  torch: string;
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

export interface Settings {
  // The CorridorKey2.0 checkout: corridorkey/, weights/, vfms/, venv/.
  corridorKeyRoot: string | null;
  lastOptions: JobOptions;
}

export interface CheckoutCheck {
  ok: boolean;
  problems: string[];
}

export type UpdateChannel = "stable" | "dev";
export interface UpdateState {
  feed: string | null; // the feed URL; null = no release channel set up
  channel: UpdateChannel;
  automatic: boolean; // check automatically (persist it)
  status: "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "error" | "unsupported";
  current: string;
  latest: string | null;
  notes: string | null;
  progress: number | null; // 0..1 while downloading
  error: string | null; // shown verbatim
  checkedAt: number | null;
}

export interface AppState {
  jobs: Job[];
  queueRunning: boolean;
  engine: EngineState;
  gpu: GpuInfo | null;
  gpuError: string | null;
  settings: Settings;
  checkout: CheckoutCheck;
}

export interface CorridorKeyApi {
  getState(): Promise<AppState>;
  onState(listener: (state: AppState) => void): () => void;
  addPaths(paths: string[]): Promise<void>;
  pickClips(): Promise<void>;
  pickFile(kind: "hint-image" | "hint-video"): Promise<string | null>;
  pickCheckout(): Promise<void>;
  pathForFile(file: File): string;
  setJobOptions(id: string, options: JobOptions): Promise<void>;
  removeJob(id: string): Promise<void>;
  retryJob(id: string): Promise<void>;
  startQueue(): Promise<void>;
  stopQueue(): Promise<void>;
  showInFolder(path: string): Promise<void>;
  setVisible(visible: boolean): void;
}
