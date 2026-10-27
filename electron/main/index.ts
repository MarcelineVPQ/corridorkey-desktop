// CorridorKey desktop: main process. One window, one queue, one engine.
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, net, powerMonitor, protocol, shell } from "electron";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EngineProcess, rustEngineEnv, type EngineReply } from "./engine";
import { Estimator } from "./estimate";
import { GPU_POLL_MS, otherGpuUsers, readGpu } from "./gpu";
import { expandPaths, probeClip, still, STILL_WIDTH, VIDEO_EXT, HINT_IMAGE_EXT } from "./media";
import { clearJobTemps, Queue } from "./queue";
import { checkRustEngine, loadSettings, saveSettings } from "./settings";
import { effectivePath, findCli, findEngineFiles, findTrtBuilder, isInsideApp, modelSetVersion, windowTitle } from "./engineFind";
import { addToPathList, APP_DIR, appDirs, engineBinName, isMac, isWin, ortLibrary, PLATFORM } from "./platform";
import { HOMEBREW_DIRS, checkFfmpeg, ffmpegState, installFfmpeg, planFor, readOsRelease, wingetFfmpegDirs } from "./ffmpeg";
import { PROGRESS_EVERY_MS } from "./updateFlow";
import {
  MODELS_BYTES,
  RUNTIME_BYTES,
  TRT_BYTES,
  freeBytes,
  installNeeds,
  runInstall,
  runTrtInstall,
  systemSupport,
  trtNeeds,
  trtReady,
  trtSupported,
  tensorrtWhyNot,
  useTensorrt,
  type InstallDeps,
} from "./install";
import { folderBytes, pruneCache, removeStorage, storageItems, TRT_ENGINES_DIR } from "./storage";
import { builtRanges, Prebuilder, rangesOnDisk, recordBuild, removeSize } from "./trtPrebuild";
import { jobLogText, saveJobLog } from "./jobLog";
import { readDesktopPalette, watchDesktopPalette } from "./desktopTheme";
import { Updater } from "./updater";
import { holdAppImageMountUntilExit } from "./appImageQuit";
import {
  LOG_SHOWN,
  type AppState,
  type FfmpegState,
  type GpuInfo,
  type InstallState,
  type StorageItem,
  type CacheInfo,
  type CardReading,
  type Job,
  type JobOptions,
  type MemoryEstimateResult,
  type OutputName,
  type TrtState,
} from "../../src/shared/types";
import { NOT_WHILE_BUSY } from "../../src/shared/texts";
import type { DesktopPalette } from "../../src/ui/theme/palette";
import { IPC } from "./ipc";
import { consoleLineArg, cursorArg, fromAppPage, idArg, pathArg, pathsArg, sanitizeAppearance, sanitizeOptions, uniqueOutputDir, vramLimit } from "./validate";
import { Console, LINE_MAX, type ElevationRequest } from "./console/runner";
import { dropOnLockAndSleep, Elevation, ELEVATION_CAP_MS, ELEVATION_TTL_MS } from "./console/elevation";
import { AuditLog, History } from "./console/logs";
import { BlockPusher } from "./console/push";
import { realPathDeps } from "./console/paths";
import { makeRegistry } from "../../src/shared/console/registry";
import { cacheDirFor, cacheInfo, cacheUnavailable, CACHE_MARKER, clearOldCache, exists, JOBS_DIR, jobTempDir, MEDIA_DIR, moveCache, prepareTarget, remapMedia, targetProblem } from "./cacheFolder";
import { gbBytes, mbOrGbBytes } from "../../src/shared/units";
import { sanitizeTrtSize, sizeRangeText, sizeText, trtSizeKey } from "../../src/shared/trt";

const here = dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env.ELECTRON_RENDERER_URL;
const MEDIA_SCHEME = "ck-media";

// Must run before app ready. Linux: Wayland only, because the app must show
// HDR (Marcy 2026-10-21: "wayland only, since this app has to support HDR
// strictly"); there is no X11/XWayland fallback. Forcing X11 had also
// crash-looped the GPU process on her RTX 5080 (exit 139). HDR: render in
// scRGB (linear, 1.0 = 80 nits), the DS5 app's measured path: KWin 6.6's color
// manager has no "srgb" transfer function, which Chromium's default asks for;
// scRGB (ext_linear + windows_scrgb) is the one that reaches the display.
export const WAYLAND_REQUIRED = PLATFORM === "linux" && !process.env.WAYLAND_DISPLAY;
function applyLinuxWorkarounds(): void {
  if (PLATFORM !== "linux") return;
  app.commandLine.appendSwitch("ozone-platform", "wayland");
  app.commandLine.appendSwitch("force-color-profile", "scrgb-linear");
  // Follow the desktop's (fractional) display scale.
  app.commandLine.appendSwitch("enable-features", "WaylandFractionalScaleV1,WaylandPerSurfaceScale");
}
applyLinuxWorkarounds();
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } }]);

const settingsFile = join(app.getPath("userData"), "settings.json");
const IS_WIN = isWin();
const IS_MAC = isMac();
// the data folder (runtime, models) and the cache (thumbnails, stills): platform.ts appDirs
const appFolders = appDirs(process.env, app.getPath("home"));
let settings = loadSettings(settingsFile);
// the cache folder: the system's, or the app's own folder in the location chosen in App settings, Storage (row 44);
// a chosen location that isn't there (drive unplugged): the system's folder for now, the setting kept, Storage says so.
// Checked async once the app is ready (checkCacheDrive; a share that stops answering mustn't hold the start); nothing
// writes to the cache before that check (adding clips and starting the queue check it first).
let cacheMissing: string | null = null;
let cacheDir = cacheDirFor(settings.cacheRoot, appFolders.cache);
let mediaDir = join(cacheDir, MEDIA_DIR);
/** Where the Engine page's lists look (engineFind.ts): the app's own engine, a dev build, the in-app install's folder. */
function enginePlaces() {
  return {
    bundledBinary: app.isPackaged ? join(process.resourcesPath, "engine", engineBinName()) : null,
    devBinary: app.isPackaged ? null : resolve(app.getAppPath(), "engine-rs", "target", "release", engineBinName()),
    data: appFolders.data,
  };
}
let engineFiles = findEngineFiles(enginePlaces());
/** The engine settings' keys, one per Engine-page list. */
const RUST_KEYS = { binary: "engineBinary", models: "modelsDir", ort: "ortLibrary" } as const;
const isRustWhat = (w: unknown): w is keyof typeof RUST_KEYS => w === "binary" || w === "models" || w === "ort";
/**
 * The paths the engine runs with: CK_ENGINE_BIN / _MODELS / _ORT when set (never saved), else each setting, or
 * (null = Automatic) the newest found.
 */
function enginePaths() {
  const env = process.env;
  return {
    binary: env.CK_ENGINE_BIN || effectivePath(settings.engineBinary, engineFiles.binary),
    models: env.CK_ENGINE_MODELS || effectivePath(settings.modelsDir, engineFiles.models),
    ort: env.CK_ENGINE_ORT || effectivePath(settings.ortLibrary, engineFiles.ort),
  };
}
let rustEngine = checkRustEngine(null, null);
// ffmpeg: "checking" until the first check (started at ready); then after an install or before a queue
let ffmpeg: FfmpegState = { checked: false, ok: false, problem: null, command: "", canInstall: false, runHint: "", note: null, installing: false, installError: null };
// the first-run install: what is missing, and its progress while it runs
function installIdle(): InstallState {
  const need = installNeeds(enginePlaces().data);
  const sys = systemSupport(PLATFORM, process.arch, existsSync, process.env);
  return {
    dir: enginePlaces().data,
    needRuntime: need.runtime,
    needModels: need.models,
    bytes: need.bytes,
    runtimeBytes: RUNTIME_BYTES,
    modelsBytes: MODELS_BYTES,
    gpuOk: sys.ok,
    gpuProblem: sys.problem,
    runtimeWhat: sys.runtime,
    status: "idle",
    step: null,
    done: 0,
    total: 0,
    error: null,
  };
}
let install = installIdle();
// the opt-in TensorRT parts: what is installed, for the setting's install box; progress while its install runs
function trtParts(): Omit<TrtState, "status" | "step" | "done" | "total" | "error" | "built" | "prebuild" | "onDisk"> {
  const supported = trtSupported(PLATFORM);
  const need = trtNeeds(enginePlaces().data);
  const paths = enginePaths();
  return {
    supported,
    on: supported && settings.tensorrt,
    ready: supported && trtReady(paths.ort, paths.models),
    needLibs: need.libs,
    needProvider: need.provider,
    needModels: need.models,
    bytes: need.bytes,
    fullBytes: TRT_BYTES,
  };
}
const trtIdle = (): Omit<TrtState, "built" | "prebuild" | "onDisk"> => ({ ...trtParts(), status: "idle", step: null, done: 0, total: 0, error: null });
let trt = trtIdle();
// one install at a time (the runtime and models, or TensorRT's parts): one Stop
let installAbort: AbortController | null = null;
let storage: StorageItem[] | null = null;
let cache: CacheInfo | null = null;
// a cache move or fresh start running (what App settings shows), and why the last one stopped
let cacheMoving: string | null = null;
let cacheError: string | null = null;
// the card's memory from the engine's last estimate (the limit menus)
let card: CardReading | null = null;
let lastInstallProgress = 0;
async function recheckFfmpeg(): Promise<void> {
  // Windows: winget's ffmpeg folders onto this process's PATH (a running program never sees PATH changes)
  if (IS_WIN && process.env.LOCALAPPDATA) process.env.PATH = addToPathList(process.env.PATH, wingetFfmpegDirs(process.env.LOCALAPPDATA), "front");
  // macOS: apps started from the Dock don't get the shell's PATH, so Homebrew's folders are added here
  if (IS_MAC) process.env.PATH = addToPathList(process.env.PATH, HOMEBREW_DIRS, "back");
  // an install still running stays running (a check while it runs must not bring the Install button back)
  ffmpeg = { ...ffmpegState(await checkFfmpeg(), planFor(PLATFORM, readOsRelease())), installing: ffmpeg.installing, installError: ffmpeg.installError };
  scheduleSend();
}
/** Re-check the engine's files (after a setting changed, or before the queue starts). */
function recheckEngines(): void {
  engineFiles = findEngineFiles(enginePlaces());
  const paths = enginePaths();
  rustEngine = checkRustEngine(paths.binary, paths.models, paths.ort);
  // the TensorRT parts follow the engine's files (a running install keeps its progress)
  trt = { ...trt, ...trtParts() };
  mainWindow?.setTitle(currentTitle());
}
/** The window title for what is set up now (engineFind.ts windowTitle). */
function currentTitle(): string {
  return windowTitle(modelSetVersion(enginePaths().models));
}
let mainWindow: BrowserWindow | null = null;
recheckEngines();
let windowShown = false;
let gpu: GpuInfo | null = null;
let gpuError: string | null = null;
let gpuTimer: NodeJS.Timeout | null = null;
let desktopPalette: DesktopPalette | null = null;
let stopPaletteWatch: (() => void) | null = null;
const updater = new Updater({ changed: () => scheduleSend(), version: app.getVersion() });

/** ck-media://f/<encoded path>: only files inside the media cache are served. */
const mediaUrl = (file: string) => `${MEDIA_SCHEME}://f/${encodeURIComponent(file)}`;
/** The file a ck-media URL names (null: not one). */
function mediaFile(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === `${MEDIA_SCHEME}:` ? decodeURIComponent(u.pathname.slice(1)) : null;
  } catch {
    // error: NOT-WORTH — not a URL: no file
    return null;
  }
}

/** The Rust engine's process, as the queue and the memory estimate start it. */
function rustEngineProcess(onReply: (r: EngineReply) => void, onExit: (code: number | null, signal: NodeJS.Signals | null, stderrTail: string[]) => void): EngineProcess {
  const paths = enginePaths();
  const trtBuild = findTrtBuilder(paths.binary, app.isPackaged ? null : resolve(app.getAppPath(), "engine-rs", "target", "dist"));
  return new EngineProcess({ binary: paths.binary!, models: paths.models!, ort: paths.ort, env: process.env, trtCache: join(cacheDir, TRT_ENGINES_DIR), trtBuild }, onReply, onExit);
}

// the Console's corridorkey has the graphics card (the Console, below)
let consoleGpu = false;
const queue = new Queue({
  makeEngine: rustEngineProcess,
  // job temp files stay on the system's local cache folder whatever the chosen location (Marcy 2026-10-26)
  tempDirFor: (id) => jobTempDir(appFolders.cache, id),
  tensorrt: () => useTensorrt({ platform: PLATFORM, setting: settings.tensorrt, ready: trtReady(enginePaths().ort, enginePaths().models) }),
  tensorrtWhyNot: () => tensorrtWhyNot({ platform: PLATFORM, setting: settings.tensorrt, ready: trtReady(enginePaths().ort, enginePaths().models) }),
  changed: () => {
    // the queue's end resumes a paused background TensorRT build
    if (!queue.running) prebuild.queueStopped();
    scheduleSend();
  },
  finished: (job) => {
    void makeStills(job);
    void refreshTrtBuilt();
  },
  saveLog: (job) => saveJobLog(job, app.getVersion()),
});
// the manual window picker's graphics-memory estimate (backlog row 41): a short-lived Rust engine, only while no queue runs
const estimator = new Estimator({ makeEngine: rustEngineProcess });
// the TensorRT ranges built for this card (read from the cache after a build, a job, a move or a removal; not per push)
let trtBuilt: string[] = [];
// each built range's size on disk and recorded build time (Engine settings, TensorRT's size list; read with trtBuilt)
let trtOnDisk: TrtState["onDisk"] = [];
// reads in flight: only the newest one's result is kept
let trtReads = 0;
/** Reads what is built (async: the cache folder can be on a network share). */
async function readTrtCache(): Promise<void> {
  const root = join(cacheDir, TRT_ENGINES_DIR);
  const n = ++trtReads;
  const built = trtSupported(PLATFORM) ? await builtRanges(root) : [];
  const onDisk = trtSupported(PLATFORM) ? await rangesOnDisk(root, folderBytes) : [];
  if (n !== trtReads) return;
  trtBuilt = built;
  trtOnDisk = onDisk;
}
async function refreshTrtBuilt(): Promise<void> {
  await readTrtCache();
  prebuild.refresh();
  scheduleSend();
}
// the background TensorRT build of the common ranges (trtPrebuild.ts): jobs never build; only while no queue runs
const prebuild: Prebuilder = new Prebuilder({
  makeEngine: rustEngineProcess,
  changed: () => {
    if (!prebuild.running) void readTrtCache().then(scheduleSend);
    scheduleSend();
  },
  sizes: () => settings.trtSizes,
  recordBuild: (range, seconds) => {
    void recordBuild(join(cacheDir, TRT_ENGINES_DIR), range, seconds).then(readTrtCache).then(scheduleSend);
  },
  allowed: () => !cacheMoving && rustEngine.ok && useTensorrt({ platform: PLATFORM, setting: settings.tensorrt, ready: trtReady(enginePaths().ort, enginePaths().models) }),
  // while the queue runs the build waits for it (paused), and goes on once its engine has exited: a build started while
  // the quitting engine still held its model would pick its window from the memory left (bug hunt 2026-10-26 P6)
  queueRunning: () => queue.running || queue.engineEnding || consoleGpu,
  othersOnGpu: async () => {
    try {
      return await otherGpuUsers();
    } catch {
      // error: NOT-WORTH — no reading (nvidia-smi missing or stuck): nothing known to wait for
      return [];
    }
  },
  built: () => trtBuilt,
  reread: readTrtCache,
});
void refreshTrtBuilt();

// The Console (backlog row 95, docs/CONSOLE.md): its own command set in this process, never a system shell. A
// corridorkey run that uses the graphics card takes it like the queue does (the estimate stops, the background TensorRT
// build waits), and the queue doesn't start while it runs (consoleGpu, above the queue).
const userData = app.getPath("userData");
const consolePush = new BlockPusher((blocks) => mainWindow?.webContents.send(IPC.consoleBlocks, blocks));
/** The sudo confirmation: the line as typed, the command as it runs, and what it would replace, counted now. */
async function confirmElevation(req: ElevationRequest): Promise<boolean> {
  if (!mainWindow) return false;
  // loop: NOT-WORTH — one or two targets per confirmation
  const targets = req.targets.map((t) => `${t.path}: ${t.files} file${t.files === 1 ? "" : "s"} at the run's names there now (${mbOrGbBytes(t.bytes)}); the run replaces them.`);
  const r = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    buttons: ["Run it", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Run this command elevated?",
    detail:
      `You typed: ${req.line}\nIt runs: ${req.command}\n\n${targets.join("\n")}\n\n` +
      `The Console stays elevated for ${ELEVATION_TTL_MS / 60_000} minutes (each elevated command extends it, at most ${ELEVATION_CAP_MS / 60_000}); sudo -k, locking the screen, sleep or quitting ends it. Every elevated command is logged.`,
  });
  return r.response === 0;
}
const appConsole = new Console({
  registry: makeRegistry(),
  paths: realPathDeps(homedir()),
  fs: {
    // loop: NOT-WORTH — one async readdir per dir / Tab / sudo count
    readdir: (p) => readdir(p, { withFileTypes: true }),
    // loop: NOT-WORTH — one async stat per listed entry
    stat: (p) => stat(p),
    readFile: async (p, max) => {
      // loop: NOT-WORTH — one async stat per script or job file read
      const s = await stat(p);
      if (!s.isFile()) throw new Error("not a file");
      if (s.size > max) throw new Error(`larger than ${max} bytes`);
      // loop: NOT-WORTH — one async read of a small file
      return readFile(p, "utf8");
    },
    mkdir: async (p) => {
      // loop: NOT-WORTH — one async mkdir per render
      await mkdir(p, { recursive: true });
    },
  },
  startDir: settings.outputRoot ?? homedir(),
  cli: () => findCli(enginePaths().binary, app.isPackaged ? null : resolve(app.getAppPath(), "engine-rs", "target", "dist")),
  cliEnv: () => {
    const paths = enginePaths();
    const env = rustEngineEnv(process.env, paths.ort);
    if (paths.models) env.CK_ENGINE_MODELS = paths.models;
    // TensorRT's engines in the app's cache folder, as the queue's (engine.ts launchCommand)
    if (!process.env.CK_ENGINE_TRT_CACHE) env.CK_ENGINE_TRT_CACHE = join(cacheDir, TRT_ENGINES_DIR);
    return env;
  },
  cliTemp: () => join(appFolders.cache, "console"),
  runtimeAllowed: (what, path) => {
    const p = enginePaths();
    // loop: NOT-WORTH — the one or two found copies
    return [p[what], ...engineFiles[what].map((f) => f.path)].some((x) => !!x && resolve(x) === path);
  },
  // loop: NOT-WORTH — the queue's jobs, once per written path checked
  writeRoots: () => [settings.outputRoot, cacheDir, appFolders.cache, ...queue.jobs.map((j) => j.outputDir)].filter((x): x is string => !!x),
  takeGpu: () => {
    if (queue.running || queue.engineEnding) return "The queue is keying on the graphics card: wait for it, or stop it, then run this.";
    if (cacheMoving) return "The cache folder is moving: wait for it, then run this.";
    // one engine at a time: an estimate gives way, the background TensorRT build waits (as for the queue)
    estimator.stop();
    prebuild.pause();
    consoleGpu = true;
    return null;
  },
  releaseGpu: () => {
    consoleGpu = false;
    prebuild.queueStopped();
  },
  confirm: confirmElevation,
  elevation: new Elevation(),
  audit: new AuditLog(join(userData, "console-audit.jsonl")),
  history: new History(join(userData, "console-history.jsonl")),
  changed: (b) => consolePush.mark(b),
  sessionChanged: () => scheduleSend(),
  version: app.getVersion(),
});

function state(): AppState {
  return {
    version: app.getVersion(),
    // each job's log trimmed to what the page shows: a long queue's pushes stay small (leak audit 2026-10-24, #4)
    // loop: HOT-PATH-OK — one shallow copy per job per state push (≤ 10/s while shown)
    jobs: queue.jobs.map((j) => (j.log.length > LOG_SHOWN ? { ...j, log: j.log.slice(-LOG_SHOWN), logLines: j.log.length } : j)),
    queueRunning: queue.running,
    engine: queue.engine,
    gpu,
    gpuError,
    settings,
    rustEngine,
    engineFiles,
    enginePaths: enginePaths(),
    ffmpeg,
    install,
    tensorrt: { ...trt, built: trtBuilt, prebuild: prebuild.state, onDisk: trtOnDisk },
    storage,
    cache,
    cacheMissing,
    card,
    desktopPalette,
    update: updater.state,
    system: { engineBin: engineBinName(), ortLib: ortLibrary().display, platform: PLATFORM, home: homedir() },
    console: appConsole.session(),
  };
}

// State goes to the page at most every 100 ms (frames already arrive ≤ 4/s), and only while the window
// is shown: a hidden page isn't re-rendered for nothing; it gets the latest state the moment it shows.
let sendTimer: NodeJS.Timeout | null = null;
let sendPending = false;
function scheduleSend(): void {
  updateGpuPolling();
  if (!windowShown) {
    sendPending = true;
    return;
  }
  if (sendTimer) return;
  // lifetime: OK — one-shot 100 ms coalescing timer, re-armed only by the next change
  // loop: HOT-PATH-OK — state pushes coalesced to ≤ 10/s, only while the window is shown (this pass); measured ~2/s during a job (engine replies), 3-134 KiB each
  sendTimer = setTimeout(() => {
    sendTimer = null;
    sendPending = false;
    mainWindow?.webContents.send(IPC.state, state());
  }, 100);
}

/** The window's shown state changed: the GPU readout follows it, and a state held back while hidden goes out. */
function setShown(v: boolean): void {
  windowShown = v;
  consolePush.setShown(v);
  updateGpuPolling();
  if (v && sendPending) scheduleSend();
}

// GPU readout: polled only while a job runs AND the window is shown (rule 3). One read at a time: a slow
// nvidia-smi (its own timeout is GPU_READ_TIMEOUT_MS) never stacks reads up.
let gpuReading = false;
async function pollGpu(): Promise<void> {
  if (gpuReading) return;
  gpuReading = true;
  try {
    const pid = queue.enginePid;
    gpu = await readGpu(new Set(pid ? [pid] : []));
    gpuError = null;
  } catch (e) {
    // error: SHOWN — the GPU card says nvidia-smi couldn't be read
    gpuError = e instanceof Error ? e.message.split("\n")[0] : String(e);
  } finally {
    gpuReading = false;
  }
  scheduleSend();
}

function updateGpuPolling(): void {
  // nvidia-smi comes with NVIDIA's driver: no readout on macOS (Core ML has no such tool)
  const want = windowShown && queue.running && !IS_MAC;
  if (want && !gpuTimer) {
    void pollGpu();
    // lifetime: OK — cleared below as soon as the queue stops or the window hides
    // loop: HOT-PATH-OK — two nvidia-smi calls every 2 s, only while a job runs and the window is shown
    gpuTimer = setInterval(() => void pollGpu(), GPU_POLL_MS);
  } else if (!want && gpuTimer) {
    clearInterval(gpuTimer);
    gpuTimer = null;
  }
}

// The desktop's colors are read (and watched) only while the Desktop theme or
// the desktop accent is chosen; otherwise nothing reads or watches them.
async function refreshPalette(): Promise<void> {
  desktopPalette = await readDesktopPalette();
  scheduleSend();
}
function updatePaletteWatch(): void {
  const want = settings.appearance.theme === "desktop" || settings.appearance.accent === "desktop";
  if (want && !stopPaletteWatch) {
    stopPaletteWatch = watchDesktopPalette(() => void refreshPalette());
    void refreshPalette();
  } else if (!want && stopPaletteWatch) {
    stopPaletteWatch();
    stopPaletteWatch = null;
    desktopPalette = null;
  }
}

/** Where a clip's results go: next to it, or into the chosen folder. */
function outputDirFor(clipParent: string, name: string): string {
  return join(settings.outputRoot ?? clipParent, `out_${name}`);
}

async function makeStills(job: Job): Promise<void> {
  if (job.status !== "done" || job.options.outputFormat !== "video") return;
  const seconds = job.clip.frames && job.clip.fps ? job.clip.frames / job.clip.fps / 2 : 0;
  const order: OutputName[] = ["checker", "alpha", "cutout", "fg"];
  // loop: SERIAL-REQUIRED — one ffmpeg at a time while the next job may be keying on the same machine
  for (const output of order) {
    // loop: NOT-WORTH — ≤ four outputs, once per finished job
    const file = job.outputs.find((f) => basename(f).includes(`_${output === "checker" ? "checker_comp" : output}`));
    // loop: NOT-WORTH — one async stat per output, once per finished job
    if (!file || !(await exists(file))) continue;
    try {
      job.stills.push({ output, url: mediaUrl(await still(mediaDir, file, seconds, STILL_WIDTH)) });
      scheduleSend();
    } catch {
      // error: NOT-WORTH — a missing still leaves the output's row without a picture; the file itself is listed
    }
  }
}

async function addPaths(paths: string[]): Promise<void> {
  await checkCacheDrive();
  // loop: SERIAL-REQUIRED — ffprobe/ffmpeg per clip, one at a time so a big drop doesn't fork dozens
  for (const { path, kind } of expandPaths(paths)) {
    // loop: NOT-WORTH — the queue's jobs per dropped clip (a drop of N clips is N × jobs comparisons)
    if (queue.jobs.some((j) => j.clip.path === path && j.status === "waiting")) continue;
    const clip = await probeClip(path, kind, mediaDir, mediaUrl);
    // the graphics memory limit starts at App settings' default (row 43), whatever the last clip had
    const options: JobOptions = { ...settings.lastOptions, hintFirstFrame: null, hintVideo: null, hintMode: "none", vramLimitGb: settings.vramLimitGb };
    if (clip.companionHintVideo) Object.assign(options, { hintMode: "video", hintVideo: clip.companionHintVideo });
    else if (clip.companionFirstFrame) Object.assign(options, { hintMode: "first-frame", hintFirstFrame: clip.companionFirstFrame });
    const parent = kind === "frames" && basename(path).toLowerCase() === "input" ? dirname(dirname(path)) : dirname(path);
    queue.add({
      id: randomUUID(),
      clip,
      options,
      // never a folder another queued clip of the same name writes to (its files have the same names)
      outputDir: uniqueOutputDir(outputDirFor(parent, clip.name), path, queue.jobs),
      status: "waiting",
      stage: null,
      stageDetail: null,
      framesDone: 0,
      framesTotal: clip.frames,
      framesPerSecond: null,
      memory: null,
      startedAt: null,
      finishedAt: null,
      outputs: [],
      stills: [],
      error: null,
      partial: null,
      log: [],
    });
  }
}

/**
 * The chosen cache folder's drive gone while the app runs (it is checked before the cache is written): the system's
 * folder for now, nothing moved or deleted, the setting kept for the next start; Storage says so.
 */
async function checkCacheDrive(): Promise<void> {
  const root = settings.cacheRoot;
  if (cacheMissing || cacheMoving || !root) return;
  const missing = await cacheUnavailable(root);
  // the location changed or a move started meanwhile: that one decides
  if (!missing || cacheMissing || cacheMoving || settings.cacheRoot !== root) return;
  cacheMissing = missing;
  cacheDir = appFolders.cache;
  mediaDir = join(cacheDir, MEDIA_DIR);
  await refreshTrtBuilt();
}

// measures in flight: only the newest one's result is kept
let storageReads = 0;
/** Storage and the cache folder, measured (walks the folders, async: only when App settings shows Storage, or after a change). */
async function measureStorage(): Promise<void> {
  await checkCacheDrive();
  const n = ++storageReads;
  const items = await storageItems(enginePlaces().data, cacheDir, systemSupport(PLATFORM, process.arch, existsSync, process.env).runtimeShort);
  const info = await cacheInfo(cacheDir, appFolders.cache, queue.jobs, mediaFile);
  if (n !== storageReads) return;
  storage = items;
  cache = { ...info, moving: cacheMoving, error: cacheError };
}

/** The cache folder from now on: `root` the chosen location (null: the system's folder), `dir` the app's folder in it. */
function switchCache(root: string | null, dir: string): void {
  settings = { ...settings, cacheRoot: root };
  persist();
  cacheMissing = null;
  cacheDir = dir;
  mediaDir = join(dir, MEDIA_DIR);
}

/**
 * Choose where the cache lives (backlog row 44): a folder dialog (or the system's folder), then, when the cache
 * holds anything, move the files or start fresh (asked). Refused while the queue or a download runs.
 */
async function pickCacheFolder(toDefault: boolean): Promise<void> {
  if (!mainWindow || cacheMoving) return;
  if (queue.running || installAbort) {
    await dialog.showMessageBox(mainWindow, { type: "info", message: NOT_WHILE_BUSY, detail: "Stop it first, then change the cache folder." });
    return;
  }
  // the chosen drive isn't there and the cache is in the system's folder for now: Default keeps it there from now on
  if (toDefault && cacheMissing && resolve(cacheDir) === resolve(appFolders.cache)) {
    switchCache(null, appFolders.cache);
    await measureStorage();
    scheduleSend();
    return;
  }
  let root: string | null = null;
  if (!toDefault) {
    const r = await dialog.showOpenDialog(mainWindow, { title: "Location for the cache folder", defaultPath: dirname(cacheDir), properties: ["openDirectory", "createDirectory"] });
    if (r.canceled || !r.filePaths[0]) return;
    const picked = r.filePaths[0];
    // the app's own cache folder itself picked (it carries the marker): its parent is the location
    // loop: NOT-WORTH — one async stat per choice
    root = basename(picked) === APP_DIR && (await exists(join(picked, CACHE_MARKER))) ? dirname(picked) : picked;
  }
  const to = cacheDirFor(root, appFolders.cache);
  const toOwned = resolve(to) === resolve(appFolders.cache);
  if (toOwned) root = null;
  const from = cacheDir;
  const fromOwned = resolve(from) === resolve(appFolders.cache);
  const problem = await targetProblem(from, to, toOwned);
  if (problem) {
    await dialog.showMessageBox(mainWindow, { type: "info", message: "The cache can't go there", detail: problem });
    return;
  }
  const trtBytes = await folderBytes(join(from, TRT_ENGINES_DIR));
  const bytes = (await folderBytes(join(from, MEDIA_DIR))) + trtBytes;
  let move = false;
  if (bytes > 0) {
    const trt = trtBytes > 0;
    const r = await dialog.showMessageBox(mainWindow, {
      type: "question",
      buttons: ["Move the files", "Start fresh", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      message: `Move the cache folder to ${to}?`,
      detail:
        `The cache holds ${mbOrGbBytes(bytes)}: clip thumbnails and result stills${trt ? ", and the TensorRT engines built for your card" : ""}.\n\n` +
        `Move the files: each file is copied, checked against the original, and only then removed from ${from}. If anything goes wrong, nothing is removed and the cache stays where it is.\n\n` +
        `Start fresh: the new folder starts empty and the old cache files are deleted. Thumbnails and stills are made again${trt ? "; the TensorRT engines are built again on the next TensorRT job (minutes per resolution range)" : ""}.`,
    });
    if (r.response === 2) return;
    move = r.response === 0;
  }
  // one engine at a time, and none while the cache moves (the estimate's engine is the only one that can run now); the
  // background TensorRT build goes on after it
  estimator.stop();
  const resumeBuild = prebuild.suspend();
  cacheMoving = move ? `Moving ${mbOrGbBytes(bytes)} to ${to}…` : `Starting fresh in ${to}…`;
  cacheError = null;
  if (cache) cache = { ...cache, moving: cacheMoving, error: null };
  void measureStorage().then(scheduleSend);
  scheduleSend();
  try {
    if (move) {
      const res = await moveCache(from, to, toOwned, fromOwned);
      if (!res.ok) {
        cacheError = res.message;
        return;
      }
      const oldMedia = join(from, MEDIA_DIR);
      switchCache(root, to);
      // the queued clips' thumbnails and stills moved with the files: same names, new folder
      // loop: NOT-WORTH — the queue's jobs, once per move
      for (const j of queue.jobs) {
        if (j.clip.thumb) j.clip.thumb = remapMedia(j.clip.thumb, oldMedia, mediaDir, mediaFile, mediaUrl);
        // loop: NOT-WORTH — ≤ four stills per job
        j.stills = j.stills.map((st) => ({ ...st, url: remapMedia(st.url, oldMedia, mediaDir, mediaFile, mediaUrl) }));
      }
      cacheError = res.message;
    } else {
      await prepareTarget(to, toOwned);
      switchCache(root, to);
      cacheError = await clearOldCache(from, fromOwned);
      // the queued clips' thumbnails and stills, made again in the new folder
      // loop: SERIAL-REQUIRED — one ffprobe + ffmpeg still per queued clip, one at a time (as adding them)
      for (const j of queue.jobs) {
        j.clip.thumb = (await probeClip(j.clip.path, j.clip.kind, mediaDir, mediaUrl)).thumb;
        j.stills = [];
        await makeStills(j);
        scheduleSend();
      }
    }
  } catch (e) {
    // error: SHOWN — App settings, Storage shows why (a move that stopped changed nothing)
    cacheError = `The cache folder wasn't changed: ${(e as Error).message}`;
  } finally {
    cacheMoving = null;
    await measureStorage();
    await refreshTrtBuilt();
    resumeBuild();
    scheduleSend();
  }
}

function persist(): void {
  try {
    saveSettings(settingsFile, settings);
  } catch (e) {
    // error: SHOWN — logged; the app keeps working with the settings in memory
    console.error("[settings] could not save:", e);
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.getState, () => state());
  // Every handler checks its arguments (validate.ts): the page is sandboxed, but what it sends is still input.
  ipcMain.handle(IPC.addPaths, (_e, paths: unknown) => addPaths(pathsArg(paths)));
  // Two dialogs: on Windows and Linux one dialog can't pick both files and folders (it falls back to a folder
  // picker, so video files couldn't be chosen at all: found in the Windows VM 2026-10-24; Electron's own note).
  ipcMain.handle(IPC.pickClips, async (_e, kindIn: unknown) => {
    const folder = kindIn === "folder";
    const r = await dialog.showOpenDialog(
      mainWindow!,
      folder
        ? { title: "Add a frame folder or a folder of clips", properties: ["openDirectory", "multiSelections"] }
        : {
            title: "Add clips",
            properties: ["openFile", "multiSelections"],
            // loop: NOT-WORTH — seven extensions, once per file dialog
            filters: [{ name: "Video", extensions: [...VIDEO_EXT].map((e) => e.slice(1)) }],
          },
    );
    if (!r.canceled) await addPaths(r.filePaths);
  });
  ipcMain.handle(IPC.pickFile, async (_e, kindArg: unknown) => {
    const kind = kindArg === "hint-video" ? "hint-video" : "hint-image";
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: kind === "hint-image" ? "First-frame hint (matte image)" : "Hint video or frame folder",
      properties: kind === "hint-image" ? ["openFile"] : ["openFile", "openDirectory"],
      // loop: NOT-WORTH — a few extensions, once per file dialog
      filters: kind === "hint-image" ? [{ name: "Matte image", extensions: [...HINT_IMAGE_EXT].map((e) => e.slice(1)) }] : [{ name: "Video", extensions: [...VIDEO_EXT].map((e) => e.slice(1)) }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle(IPC.pickRustEngine, async (_e, whatArg: unknown) => {
    if (!isRustWhat(whatArg)) return;
    const what = whatArg;
    const opts = {
      binary: { title: "The CorridorKey engine program (corridorkey-engine)", properties: ["openFile"] as const },
      models: { title: "The folder with the CorridorKey ONNX models", properties: ["openDirectory"] as const },
      ort: { title: `ONNX Runtime's library (${ortLibrary().display}) for the graphics card`, properties: ["openFile"] as const },
    }[what];
    const r = await dialog.showOpenDialog(mainWindow!, { title: opts.title, properties: [...opts.properties] });
    if (r.canceled) return;
    settings = { ...settings, [RUST_KEYS[what]]: r.filePaths[0] };
    recheckEngines();
    persist();
    scheduleSend();
  });
  ipcMain.handle(IPC.setRustEngine, (_e, whatArg: unknown, pathArgIn: unknown) => {
    if (!isRustWhat(whatArg)) return;
    const key = RUST_KEYS[whatArg];
    // null = Automatic; otherwise only a path the list offers, or the one already chosen with Browse…
    // loop: NOT-WORTH — one or two found copies, once per list choice
    const offered = engineFiles[whatArg].some((f) => f.path === pathArgIn) || pathArgIn === settings[key];
    if (pathArgIn !== null && !(typeof pathArgIn === "string" && offered)) return;
    // the copy inside the app lives in the AppImage's mount, a new path every launch: saved as Automatic
    settings = { ...settings, [key]: isInsideApp(pathArgIn, app.isPackaged ? process.resourcesPath : null) ? null : pathArgIn };
    recheckEngines();
    persist();
    scheduleSend();
  });
  ipcMain.handle(IPC.startInstall, async (_e, partIn: unknown) => {
    const isTrt = partIn === "tensorrt";
    if (installAbort || !install.gpuOk) return;
    // TensorRT goes on top of the runtime and models (its switch shows the box only then), on Linux
    if (isTrt && (!trt.supported || install.needRuntime || install.needModels)) return;
    installAbort = new AbortController();
    if (isTrt) trt = { ...trt, status: "running", error: null, step: "Starting", done: 0, total: trt.bytes };
    else install = { ...install, status: "running", error: null, step: "Starting", done: 0, total: install.bytes };
    scheduleSend();
    let lastStep: string | null = null;
    const deps: InstallDeps = {
      // loop: NOT-WORTH — the fetch the install is given; downloadVerified sets a connect timeout and a stall deadline [bounded: CONNECT_TIMEOUT_MS / STALL_TIMEOUT_MS]
      fetch: (url, init) => net.fetch(url, init),
      // at most 4 updates a second (the updater's PROGRESS_EVERY_MS), and always a new step or the end
      progress: (done, total, step) => {
        const t = Date.now();
        if (step === lastStep && done < total && t - lastInstallProgress < PROGRESS_EVERY_MS) return;
        lastInstallProgress = t;
        lastStep = step;
        if (isTrt) trt = { ...trt, done, total, step };
        else install = { ...install, done, total, step };
        scheduleSend();
      },
      abort: installAbort.signal,
      freeBytes,
    };
    let error: string | null = null;
    try {
      await (isTrt ? runTrtInstall(enginePlaces().data, deps) : runInstall(enginePlaces().data, deps));
    } catch (e) {
      // error: SHOWN — the install box (Engine page) and its task; a retry resumes the downloads
      // a stop is not an error: what arrived is kept and the next start resumes
      error = installAbort?.signal.aborted ? null : (e as Error).message;
    }
    installAbort = null;
    install = { ...installIdle(), ...(!isTrt && error ? { status: "error" as const, error } : {}) };
    trt = { ...trtIdle(), ...(isTrt && error ? { status: "error" as const, error } : {}) };
    recheckEngines();
    // TensorRT's parts just arrived: build the common ranges in the background (the setting is on: the box was shown)
    if (isTrt && !error) void prebuild.start(false);
    scheduleSend();
  });
  ipcMain.handle(IPC.setTensorrt, (_e, on: unknown) => {
    if (!trtSupported(PLATFORM)) return;
    settings = { ...settings, tensorrt: on === true };
    trt = { ...trt, ...trtParts() };
    persist();
    // switched on with its parts there: the background build; switched off: it stops
    if (settings.tensorrt) void prebuild.start(false);
    else prebuild.stop();
    scheduleSend();
  });
  ipcMain.handle(IPC.trtPrebuild, (_e, action: unknown) => {
    if (action === "start") void prebuild.start(true);
    else if (action === "stop") prebuild.stop();
  });
  // the sizes TensorRT builds for (Engine settings, TensorRT; a waiting clip's "Build for this clip's size"; row 56)
  ipcMain.handle(IPC.trtSize, async (_e, actionIn: unknown, sizeIn: unknown) => {
    const size = sanitizeTrtSize(sizeIn);
    const key = size && trtSizeKey(size.width, size.height);
    if (!trtSupported(PLATFORM) || !size || !key) return;
    // loop: NOT-WORTH — the few chosen sizes, once per click
    const others = settings.trtSizes.filter((s) => trtSizeKey(s.width, s.height) !== key);
    if (actionIn === "add") {
      // one size per range: the newest choice is the size it is built for
      settings = { ...settings, trtSizes: [...others, size] };
      persist();
      prebuild.refresh();
      // it builds now, or after the queue; while another program uses the card (Sonata) it waits for it (Marcy 2026-10-25)
      void prebuild.start(false);
      return scheduleSend();
    }
    if (actionIn !== "remove" || !mainWindow || cacheMoving) return;
    const root = join(cacheDir, TRT_ENGINES_DIR);
    // loop: NOT-WORTH — the few built ranges, once per click
    const onDisk = trtOnDisk.filter((r) => r.range.startsWith(`${key}_t`));
    if (onDisk.length > 0) {
      // a job may be running on these engines
      if (queue.running) {
        await dialog.showMessageBox(mainWindow, { type: "info", message: "Not while the queue runs", detail: "Stop it first, then remove." });
        return;
      }
      // loop: NOT-WORTH — as above
      const bytes = onDisk.reduce((n, r) => n + r.bytes, 0);
      const r = await dialog.showMessageBox(mainWindow, {
        type: "question",
        buttons: ["Remove", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        message: `Remove TensorRT for ${sizeRangeText(key)}?`,
        detail: `This deletes the engines built for ${sizeText(size)} and every size in its range (${gbBytes(bytes)}). Clips of these sizes run on CUDA until it is built again.`,
      });
      if (r.response !== 0) return;
    }
    // the background build writes into these folders: it ends first, and goes on with the other sizes after (also one
    // that was waiting for the queue or for the card)
    const resume = prebuild.suspend();
    settings = { ...settings, trtSizes: others };
    persist();
    await removeSize(root, key);
    await refreshTrtBuilt();
    resume();
    scheduleSend();
  });
  ipcMain.handle(IPC.stopInstall, () => installAbort?.abort());
  ipcMain.handle(IPC.measureStorage, async () => {
    await measureStorage();
    scheduleSend();
  });
  ipcMain.handle(IPC.openStorageFolder, async (_e, idIn: unknown) => {
    // only the app's own folders: the cache folder, or one Storage lists
    const items = idIn === "cache-root" ? [] : await storageItems(enginePlaces().data, cacheDir, systemSupport(PLATFORM, process.arch, existsSync, process.env).runtimeShort);
    // loop: NOT-WORTH — four items, once per click
    const p = idIn === "cache-root" ? cacheDir : items.find((i) => i.id === idIn)?.path;
    // loop: NOT-WORTH — one async stat per click
    if (!p || !(await exists(p))) return;
    // loop: NOT-WORTH — hands the folder to the file manager once per click
    // gate: shell-ok — p is one of the app's own folders (the cache folder, or one Storage lists), never a file
    const err = await shell.openPath(p);
    // error: SHOWN — the file manager couldn't be started: a message box says why
    if (err && mainWindow) await dialog.showMessageBox(mainWindow, { type: "info", message: "The folder couldn't be opened", detail: `${p}: ${err}` });
  });
  ipcMain.handle(IPC.pickCacheFolder, async (_e, toIn: unknown) => pickCacheFolder(toIn === "default"));
  ipcMain.handle(IPC.setVramLimitDefault, (_e, gbIn: unknown) => {
    settings = { ...settings, vramLimitGb: vramLimit(gbIn) };
    persist();
    scheduleSend();
  });
  ipcMain.handle(IPC.removeStorage, async (_e, idIn: unknown) => {
    // loop: NOT-WORTH — three items, once per click
    const item = (await storageItems(enginePlaces().data, cacheDir, systemSupport(PLATFORM, process.arch, existsSync, process.env).runtimeShort)).find((i) => i.id === idIn);
    if (!item || !mainWindow || cacheMoving) return;
    if (queue.running || installAbort) {
      await dialog.showMessageBox(mainWindow, { type: "info", message: NOT_WHILE_BUSY, detail: "Stop it first, then remove." });
      return;
    }
    const again =
      item.id === "cache"
        ? "It is rebuilt as needed."
        : item.id === "tensorrt"
          ? "Jobs run on CUDA without it; the TensorRT switch (Engine settings) downloads it again."
          : "The setup downloads it again when you need it.";
    const what =
      item.id === "tensorrt"
        ? `NVIDIA's TensorRT libraries in ${item.path}, the TensorRT models next to the CorridorKey models and the engines built in ${join(cacheDir, TRT_ENGINES_DIR)}`
        : item.path;
    const r = await dialog.showMessageBox(mainWindow, {
      type: "question",
      buttons: ["Remove", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: item.id === "tensorrt" ? "Remove TensorRT?" : `Remove the ${item.label.toLowerCase()}?`,
      detail: `This deletes ${what} (${(item.bytes / 1e9).toFixed(2)} GB). ${again}`,
    });
    if (r.response !== 0) return;
    // the background TensorRT build writes into the cache folder: it ends first (and goes on after while it still can)
    const resumeBuild = prebuild.suspend();
    await removeStorage(item, enginePlaces().data, cacheDir);
    await measureStorage();
    install = installIdle();
    trt = trtIdle();
    await refreshTrtBuilt();
    recheckEngines();
    resumeBuild();
    scheduleSend();
  });
  ipcMain.handle(IPC.installFfmpeg, async () => {
    if (ffmpeg.ok || ffmpeg.installing) return;
    ffmpeg = { ...ffmpeg, installing: true, installError: null };
    scheduleSend();
    try {
      await installFfmpeg(planFor(PLATFORM, readOsRelease()));
      ffmpeg = { ...ffmpeg, installing: false };
    } catch (e) {
      // error: SHOWN — the Engine page's ffmpeg section shows it next to the command
      ffmpeg = { ...ffmpeg, installing: false, installError: (e as Error).message };
    }
    await recheckFfmpeg();
    // found after all (e.g. winget: "already installed"): no error to show
    if (ffmpeg.ok) ffmpeg = { ...ffmpeg, installError: null };
  });
  ipcMain.handle(IPC.setJobOptions, (_e, idIn: unknown, optionsIn: unknown) => {
    const id = idArg(idIn);
    if (!id) return;
    const options: JobOptions = sanitizeOptions(optionsIn);
    queue.setOptions(id, options);
    settings = { ...settings, lastOptions: { ...options, hintFirstFrame: null, hintVideo: null, hintMode: "none" } };
    persist();
  });
  ipcMain.handle(IPC.estimateMemory, async (_e, idIn: unknown): Promise<MemoryEstimateResult> => {
    const id = idArg(idIn);
    // loop: NOT-WORTH — the queue's jobs, once per estimate asked
    const job = id ? queue.jobs.find((j) => j.id === id) : undefined;
    if (!job || job.status !== "waiting") return { ok: false, reason: "Only for a clip that hasn't run yet." };
    if (!rustEngine.ok) return { ok: false, reason: "The memory estimate comes from the Rust engine (set it up on the Engine page)." };
    const r = await estimator.ask(job.clip.path, queue.running || consoleGpu, job.options.vramLimitGb, job.options.modelScale);
    // the card's memory as this reading saw it, for App settings' limit menu
    if (r.ok && !r.stale && (r.estimate.totalBytes !== null || r.estimate.freeBytes !== null)) {
      card = { totalBytes: r.estimate.totalBytes, freeBytes: r.estimate.freeBytes, at: r.estimate.at };
      scheduleSend();
    }
    return r;
  });
  ipcMain.handle(IPC.removeJob, (_e, id: unknown) => {
    const v = idArg(id);
    if (v) queue.remove(v);
  });
  ipcMain.handle(IPC.retryJob, (_e, id: unknown) => {
    const v = idArg(id);
    if (v) queue.retry(v);
  });
  ipcMain.handle(IPC.startQueue, async () => {
    recheckEngines();
    await recheckFfmpeg();
    await checkCacheDrive();
    // not while the cache folder moves (a job writes its TensorRT engines there; its working files stay in the system's folder)
    if (!rustEngine.ok || !ffmpeg.ok || cacheMoving) return scheduleSend();
    // the Console's corridorkey has the card (one GPU job at a time)
    if (consoleGpu) {
      if (mainWindow)
        await dialog.showMessageBox(mainWindow, {
          type: "info",
          message: NOT_WHILE_BUSY,
          detail: "The Console is running corridorkey on the graphics card. Wait for it, or stop it (Ctrl+C in the Console), then start the queue.",
        });
      return;
    }
    // one engine at a time: an estimate still asking gives way to the queue
    estimator.stop();
    // the queue has the card: the background TensorRT build pauses, and goes on when the queue stops
    prebuild.pause();
    return queue.start();
  });
  ipcMain.handle(IPC.stopQueue, () => queue.stop());
  ipcMain.handle(IPC.showInFolder, (_e, pathIn: unknown) => {
    const p = pathArg(pathIn);
    if (p) shell.showItemInFolder(p);
  });
  // a path's Copy button (src/ui/PathText.tsx) and the Console's Copy output (≤ 2000 lines of ≤ 4000 characters):
  // plain text only, bounded
  ipcMain.handle(IPC.copyText, (_e, textIn: unknown) => {
    if (typeof textIn !== "string" || textIn.length === 0 || textIn.length > 8_500_000) return false;
    clipboard.writeText(textIn);
    return true;
  });
  // Copy log (the job page): the whole log as its <clip>_log.txt has it, built from the job the main process keeps
  ipcMain.handle(IPC.copyJobLog, (_e, idIn: unknown) => {
    const id = idArg(idIn);
    // loop: NOT-WORTH — the queue's jobs, once per click
    const job = id ? queue.jobs.find((j) => j.id === id) : undefined;
    if (!job) return false;
    clipboard.writeText(jobLogText(job, app.getVersion()));
    return true;
  });
  ipcMain.handle(IPC.setAppearance, (_e, aIn: unknown) => {
    const a = sanitizeAppearance(aIn);
    settings = { ...settings, appearance: a };
    nativeTheme.themeSource = a.theme === "light" ? "light" : a.theme === "dark" ? "dark" : "system";
    persist();
    updatePaletteWatch();
    scheduleSend();
  });
  ipcMain.handle(IPC.pickOutputRoot, async () => {
    const r = await dialog.showOpenDialog(mainWindow!, { title: "Folder for results", properties: ["openDirectory", "createDirectory"] });
    if (r.canceled) return;
    settings = { ...settings, outputRoot: r.filePaths[0] };
    persist();
    scheduleSend();
  });
  ipcMain.handle(IPC.clearOutputRoot, () => {
    settings = { ...settings, outputRoot: null };
    persist();
    scheduleSend();
  });
  ipcMain.handle(IPC.checkForUpdates, () => updater.check(true));
  ipcMain.handle(IPC.setUpdateChannel, (_e, c: unknown) => updater.setChannel(c === "dev" ? "dev" : "stable"));
  ipcMain.handle(IPC.setAutoUpdate, (_e, on: unknown) => updater.setAutomatic(on === true));
  ipcMain.handle(IPC.installUpdate, () => updater.download());
  // Never restart into an update while the queue runs (it would kill a job).
  ipcMain.handle(IPC.restartToUpdate, () => {
    if (!queue.running) updater.restart();
  });
  ipcMain.handle(IPC.backToStable, () => updater.backToStable());
  ipcMain.on(IPC.setVisible, (_e, visible: unknown) => setShown(visible === true));
  // The Console: only the app's own page (its window's top frame), every argument checked; the line is parsed and
  // checked again in the runner whatever the page showed
  const page = (e: Electron.IpcMainInvokeEvent) => fromAppPage(e, mainWindow?.webContents);
  ipcMain.handle(IPC.consoleRun, (e, lineIn: unknown) => {
    const line = consoleLineArg(lineIn, LINE_MAX);
    return page(e) && line !== null ? appConsole.run(line) : null;
  });
  ipcMain.handle(IPC.consoleCancel, (e) => {
    if (page(e)) appConsole.cancel();
  });
  ipcMain.handle(IPC.consoleComplete, (e, lineIn: unknown, cursorIn: unknown) => {
    const line = consoleLineArg(lineIn, LINE_MAX);
    const cursor = line === null ? null : cursorArg(cursorIn, line);
    return page(e) && line !== null && cursor !== null ? appConsole.complete(line, cursor) : { start: 0, end: 0, items: [] };
  });
  ipcMain.handle(IPC.consoleHistory, (e, queryIn: unknown) => {
    const q = consoleLineArg(queryIn, 200);
    return page(e) && q !== null ? appConsole.history(q) : [];
  });
  ipcMain.handle(IPC.consoleElevationDrop, (e) => {
    if (page(e)) appConsole.dropElevation("dropped from the Console's panel");
  });
}

function createWindow(): void {
  // lifetime: OK — one window; "closed" drops the reference
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: currentTitle(),
    backgroundColor: "#16181d", // theme-exempt: first paint before the page's tokens load (matches --bg-0 dark)
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  const shown = (v: boolean) => () => setShown(v);
  // the title is the app's own (CorridorKey 2.0 — Rust + ONNX), not the page's <title>
  mainWindow.on("page-title-updated", (e) => e.preventDefault());
  mainWindow.on("show", shown(true));
  mainWindow.on("restore", shown(true));
  mainWindow.on("hide", shown(false));
  mainWindow.on("minimize", shown(false));
  mainWindow.on("closed", () => {
    mainWindow = null;
    setShown(false);
  });
  // No navigation away from the app, no new windows.
  mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());
  // Links (About's credits) open in the default browser; https only, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (devServerUrl) void mainWindow.loadURL(devServerUrl);
  else void mainWindow.loadFile(join(here, "../renderer/index.html"));
}

// One copy at a time: a second start brings the first window forward. app.quit() doesn't stop this module or
// the ready event: measured (tools-style isolated test, two copies on one profile), the second copy still ran
// whenReady and removed the first copy's running job folder. So the second copy does nothing at ready.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!primary) return;
  if (WAYLAND_REQUIRED) {
    dialog.showErrorBox(
      "CorridorKey needs Wayland",
      "CorridorKey Desktop runs only in a Wayland session, so HDR footage and results can be shown as HDR. Log in to a Wayland session (Plasma, GNOME) and start it again.",
    );
    app.quit();
    return;
  }
  void recheckFfmpeg();
  // the Console's elevation ends when the screen locks or the computer sleeps (never on the window's blur: Alt+Tab
  // to Nuke and back is the look-dev loop sudo exists for); powerMonitor works only once the app is ready
  dropOnLockAndSleep(powerMonitor, (why) => appConsole.dropElevation(why));
  protocol.handle(MEDIA_SCHEME, (req) => {
    const file = decodeURIComponent(new URL(req.url).pathname.slice(1));
    if (!resolve(file).startsWith(mediaDir + sep)) return new Response("not found", { status: 404 });
    // loop: NOT-WORTH — one local file per media request (thumbnails / stills from the app's cache) [bounded: a local file: URL]
    return net.fetch(pathToFileURL(file).toString());
  });
  // one copy runs (single-instance lock) and no engine yet: any job folder is left over from a crash (job temps are
  // always in the system's local cache folder: jobTempDir)
  clearJobTemps(join(appFolders.cache, JOBS_DIR));
  // the chosen cache folder is checked, then its stills older than 30 days, or past 500 MB, go (storage.ts); async,
  // so a cache folder on a share that stopped answering doesn't hold the window
  void checkCacheDrive()
    .then(() => pruneCache(mediaDir))
    // error: NOT-WORTH — the stills stay until the next start; nothing else depends on the prune
    .catch(() => {});
  nativeTheme.themeSource = settings.appearance.theme === "light" ? "light" : settings.appearance.theme === "dark" ? "dark" : "system";
  updatePaletteWatch();
  registerIpc();
  createWindow();
  updater.start();
});

// The quit waits for a running job's started files to be deleted (bug hunt 2026-10-26 Q1; async now, partial.ts), at
// most this long: an output share that stopped answering can't hold the quit (under updater.ts's 10 s exit after an update).
const QUIT_CLEANUP_MS = 8_000;
let quitCleaned = false;
app.on("before-quit", (e) => {
  if (quitCleaned) return;
  quitCleaned = true;
  e.preventDefault();
  // a running corridorkey stops cleanly (SIGTERM), or is killed within the grace: it doesn't end with the app on its own
  const cleanup = Promise.all([queue.shutdown(), appConsole.shutdown()]);
  estimator.stop();
  prebuild.stop();
  stopPaletteWatch?.();
  updater.stop();
  // loop: NOT-WORTH — one wait at quit [bounded: QUIT_CLEANUP_MS]
  void Promise.race([cleanup, new Promise((r) => setTimeout(r, QUIT_CLEANUP_MS))]).then(() => app.quit());
});
app.on("window-all-closed", () => app.quit());
// The DS5 app's AppImage mount guard: keeps the mount until the process is gone, so quitting never crashes on the way out.
app.on("will-quit", () => holdAppImageMountUntilExit());
