// The app states the unit tests start from, one typed builder each: sensible defaults (a set-up app with nothing
// to do: ffmpeg found, nothing missing, TensorRT off, the queue empty) plus the overrides a test is about.
import {
  DEFAULT_APPEARANCE,
  DEFAULT_OPTIONS,
  type AppState,
  type ClipInfo,
  type FfmpegState,
  type InstallState,
  type Job,
  type Settings,
  type TrtState,
  type UpdateState,
} from "../../src/shared/types";

/** A readable 640×360 video clip of 24 frames, /c/<id>.mp4. */
export const clipInfo = (id: string, over: Partial<ClipInfo> = {}): ClipInfo => ({
  path: `/c/${id}.mp4`,
  name: id,
  kind: "video",
  width: 640,
  height: 360,
  fps: 24,
  frames: 24,
  thumb: null,
  companionFirstFrame: null,
  companionHintVideo: null,
  probeError: null,
  ...over,
});

/** A waiting job for clipInfo(id), with the default options, results in /c/out_<id>. */
export const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  clip: clipInfo(id),
  options: { ...DEFAULT_OPTIONS },
  outputDir: `/c/out_${id}`,
  status: "waiting",
  stage: null,
  stageDetail: null,
  framesDone: 0,
  framesTotal: 24,
  framesPerSecond: null,
  memory: null,
  startedAt: null,
  finishedAt: null,
  outputs: [],
  stills: [],
  error: null,
  partial: null,
  log: [],
  ...over,
});

/** The first-run install with nothing missing, idle. */
export const installState = (over: Partial<InstallState> = {}): InstallState => ({
  dir: "/d",
  needRuntime: false,
  needModels: false,
  bytes: 0,
  runtimeBytes: 0,
  modelsBytes: 0,
  gpuOk: true,
  gpuProblem: null,
  runtimeWhat: "",
  status: "idle",
  step: null,
  done: 0,
  total: 0,
  error: null,
  ...over,
});

/** TensorRT supported, off, nothing to download. */
export const trtState = (over: Partial<TrtState> = {}): TrtState => ({
  supported: true,
  on: false,
  ready: false,
  needLibs: false,
  needProvider: false,
  needModels: false,
  bytes: 0,
  fullBytes: 0,
  status: "idle",
  step: null,
  done: 0,
  total: 0,
  error: null,
  ...over,
});

/** ffmpeg checked and found. */
export const ffmpegState = (over: Partial<FfmpegState> = {}): FfmpegState => ({
  checked: true,
  ok: true,
  problem: null,
  command: "",
  canInstall: false,
  runHint: "",
  note: null,
  installing: false,
  installError: null,
  ...over,
});

/** The saved settings: a CorridorKey2.0 checkout at /ck, everything else as on a first start. */
export const settings = (over: Partial<Settings> = {}): Settings => ({
  corridorKeyRoot: "/ck",
  lastOptions: DEFAULT_OPTIONS,
  appearance: DEFAULT_APPEARANCE,
  outputRoot: null,
  engineBinary: null,
  modelsDir: null,
  ortLibrary: null,
  tensorrt: false,
  vramLimitGb: null,
  cacheRoot: null,
  ...over,
});

const updateState = (): UpdateState => ({
  feed: null,
  channel: "stable",
  automatic: false,
  status: "idle",
  current: "0.1.0-dev.1",
  latest: null,
  notes: null,
  progress: null,
  error: null,
  checkedAt: null,
});

/**
 * The whole app state: the PyTorch reference engine set up from /ck (the ONNX Runtime engine not, its first
 * problem being the engine program), the install and ffmpeg done, TensorRT off, no jobs, the engine stopped.
 */
export const appState = (over: Partial<AppState> = {}): AppState => ({
  version: "0.1.0-dev.1",
  jobs: [],
  queueRunning: false,
  engine: { status: "stopped", pong: null, error: null },
  gpu: null,
  gpuError: null,
  settings: settings(),
  checkout: { ok: true, problems: [] },
  rustEngine: { ok: false, problems: ["Choose the CorridorKey engine program (corridorkey-engine)."] },
  engineKind: "python",
  engineFiles: { binary: [], models: [], ort: [] },
  ffmpeg: ffmpegState(),
  install: installState(),
  tensorrt: trtState(),
  storage: null,
  cache: null,
  cacheMissing: null,
  card: null,
  enginePaths: { binary: null, models: null, ort: null },
  desktopPalette: null,
  update: updateState(),
  system: { engineBin: "corridorkey-engine", ortLib: "libonnxruntime.so", platform: "linux" },
  ...over,
});
