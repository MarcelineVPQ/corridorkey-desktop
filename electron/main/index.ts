// CorridorKey desktop: main process. One window, one queue, one engine.
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, shell } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EngineProcess, type EngineReply } from "./engine";
import { Estimator } from "./estimate";
import { GPU_POLL_MS, readGpu } from "./gpu";
import { expandPaths, probeClip, still, STILL_WIDTH, VIDEO_EXT, HINT_IMAGE_EXT } from "./media";
import { clearJobTemps, Queue } from "./queue";
import { checkCheckout, checkRustEngine, chooseEngine, loadSettings, saveSettings } from "./settings";
import { effectivePath, findEngineFiles, findTrtBuilder, isInsideApp, modelSetVersion, windowTitle } from "./engineFind";
import { addToPathList, appDirs, engineBinName, isMac, isWin, ortLibrary, PLATFORM } from "./platform";
import { HOMEBREW_DIRS, checkFfmpeg, ffmpegState, installFfmpeg, planFor, readOsRelease, wingetFfmpegDirs } from "./ffmpeg";
import { PROGRESS_EVERY_MS } from "./updateFlow";
import { MODELS_BYTES, RUNTIME_BYTES, TRT_BYTES, freeBytes, installNeeds, runInstall, runTrtInstall, systemSupport, trtNeeds, trtReady, trtSupported, useTensorrt, type InstallDeps } from "./install";
import { pruneCache, removeStorage, storageItems, TRT_ENGINES_DIR } from "./storage";
import { readDesktopPalette, watchDesktopPalette } from "./desktopTheme";
import { Updater } from "./updater";
import { holdAppImageMountUntilExit } from "./appImageQuit";
import {
  LOG_SHOWN,
  type AppState,
  type EngineKind,
  type FfmpegState,
  type GpuInfo,
  type InstallState,
  type StorageItem,
  type Job,
  type JobOptions,
  type MemoryEstimateResult,
  type OutputName,
  type TrtState,
} from "../../src/shared/types";
import { NOT_WHILE_BUSY } from "../../src/shared/texts";
import type { DesktopPalette } from "../../src/ui/theme/palette";
import { IPC } from "./ipc";
import { idArg, pathArg, pathsArg, sanitizeAppearance, sanitizeOptions, uniqueOutputDir } from "./validate";

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
const cacheDir = appFolders.cache;
const mediaDir = join(cacheDir, "media");
let settings = loadSettings(settingsFile, process.env);
let checkout = checkCheckout(settings.corridorKeyRoot);
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
function trtParts(): Omit<TrtState, "status" | "step" | "done" | "total" | "error"> {
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
const trtIdle = (): TrtState => ({ ...trtParts(), status: "idle", step: null, done: 0, total: 0, error: null });
let trt = trtIdle();
// one install at a time (the runtime and models, or TensorRT's parts): one Stop
let installAbort: AbortController | null = null;
let storage: StorageItem[] | null = null;
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
/** Re-check both engines' files (after a setting changed, or before the queue starts). */
function recheckEngines(): void {
  checkout = checkCheckout(settings.corridorKeyRoot);
  engineFiles = findEngineFiles(enginePlaces());
  const paths = enginePaths();
  rustEngine = checkRustEngine(paths.binary, paths.models, paths.ort);
  // the TensorRT parts follow the engine's files (a running install keeps its progress)
  trt = { ...trt, ...trtParts() };
  mainWindow?.setTitle(currentTitle());
}
/** The window title for what is set up now (engineFind.ts windowTitle). */
function currentTitle(): string {
  return windowTitle(chooseEngine(rustEngine, checkout), modelSetVersion(enginePaths().models));
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

function engineScript(): string {
  // packaged: engine/ is unpacked next to app.asar (python can't read inside the asar)
  return app.isPackaged ? join(process.resourcesPath, "app.asar.unpacked", "engine", "ck_engine.py") : resolve(app.getAppPath(), "engine", "ck_engine.py");
}

/** The Rust engine's process, as the queue and the memory estimate start it. */
function rustEngineProcess(onReply: (r: EngineReply) => void, onExit: (code: number | null, signal: NodeJS.Signals | null, stderrTail: string[]) => void): EngineProcess {
  const paths = enginePaths();
  const trtBuild = findTrtBuilder(paths.binary, app.isPackaged ? null : resolve(app.getAppPath(), "engine-rs", "target", "dist"));
  return new EngineProcess({ kind: "rust", binary: paths.binary!, models: paths.models!, ort: paths.ort, env: process.env, trtCache: join(cacheDir, TRT_ENGINES_DIR), trtBuild }, onReply, onExit);
}

// which engine the queue started (TensorRT is asked of the Rust engine only)
let runningKind: EngineKind | null = null;
const queue = new Queue({
  makeEngine: (onReply, onExit) => {
    // the Rust engine when it is set up; the PyTorch engine (CorridorKey checkout) until it replaces it
    runningKind = chooseEngine(rustEngine, checkout);
    if (runningKind === "rust") return rustEngineProcess(onReply, onExit);
    const root = settings.corridorKeyRoot!;
    return new EngineProcess({ python: join(root, "venv", "bin", "python"), script: engineScript(), packageRoot: root, env: process.env }, onReply, onExit);
  },
  tempDirFor: (id) => join(cacheDir, "jobs", id),
  tensorrt: () => useTensorrt({ platform: PLATFORM, setting: settings.tensorrt, engine: runningKind, ready: trtReady(enginePaths().ort, enginePaths().models) }),
  changed: () => scheduleSend(),
  finished: (job) => void makeStills(job),
});
// the manual window picker's graphics-memory estimate (backlog row 41): a short-lived Rust engine, only while no queue runs
const estimator = new Estimator({ makeEngine: rustEngineProcess });

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
    checkout,
    rustEngine,
    engineKind: chooseEngine(rustEngine, checkout),
    engineFiles,
    enginePaths: enginePaths(),
    ffmpeg,
    install,
    tensorrt: trt,
    storage,
    desktopPalette,
    update: updater.state,
    system: { engineBin: engineBinName(), ortLib: ortLibrary().display, platform: PLATFORM },
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
    // loop: NOT-WORTH — one stat per output, once per finished job
    if (!file || !existsSync(file)) continue;
    try {
      job.stills.push({ output, url: mediaUrl(await still(mediaDir, file, seconds, STILL_WIDTH)) });
      scheduleSend();
    } catch {
      // error: NOT-WORTH — a missing still leaves the output's row without a picture; the file itself is listed
    }
  }
}

async function addPaths(paths: string[]): Promise<void> {
  // loop: SERIAL-REQUIRED — ffprobe/ffmpeg per clip, one at a time so a big drop doesn't fork dozens
  for (const { path, kind } of expandPaths(paths)) {
    // loop: NOT-WORTH — the queue's jobs per dropped clip (a drop of N clips is N × jobs comparisons)
    if (queue.jobs.some((j) => j.clip.path === path && j.status === "waiting")) continue;
    const clip = await probeClip(path, kind, mediaDir, mediaUrl);
    const options: JobOptions = { ...settings.lastOptions, hintFirstFrame: null, hintVideo: null, hintMode: "none" };
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
  ipcMain.handle(IPC.pickCheckout, async () => {
    const r = await dialog.showOpenDialog(mainWindow!, { title: "Your CorridorKey2.0 folder", properties: ["openDirectory"] });
    if (r.canceled) return;
    settings = { ...settings, corridorKeyRoot: r.filePaths[0] };
    recheckEngines();
    persist();
    scheduleSend();
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
    scheduleSend();
  });
  ipcMain.handle(IPC.setTensorrt, (_e, on: unknown) => {
    if (!trtSupported(PLATFORM)) return;
    settings = { ...settings, tensorrt: on === true };
    trt = { ...trt, ...trtParts() };
    persist();
    scheduleSend();
  });
  ipcMain.handle(IPC.stopInstall, () => installAbort?.abort());
  ipcMain.handle(IPC.measureStorage, () => {
    storage = storageItems(enginePlaces().data, cacheDir, systemSupport(PLATFORM, process.arch, existsSync, process.env).runtimeShort);
    scheduleSend();
  });
  ipcMain.handle(IPC.removeStorage, async (_e, idIn: unknown) => {
    // loop: NOT-WORTH — three items, once per click
    const item = storageItems(enginePlaces().data, cacheDir, systemSupport(PLATFORM, process.arch, existsSync, process.env).runtimeShort).find((i) => i.id === idIn);
    if (!item || !mainWindow) return;
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
    removeStorage(item, enginePlaces().data, cacheDir);
    storage = storageItems(enginePlaces().data, cacheDir, systemSupport(PLATFORM, process.arch, existsSync, process.env).runtimeShort);
    install = installIdle();
    trt = trtIdle();
    recheckEngines();
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
    if (chooseEngine(rustEngine, checkout) !== "rust") return { ok: false, reason: "The memory estimate comes from the Rust engine (set it up on the Engine page)." };
    return estimator.ask(job.clip.path, queue.running);
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
    if (!chooseEngine(rustEngine, checkout) || !ffmpeg.ok) return scheduleSend();
    // one engine at a time: an estimate still asking gives way to the queue
    estimator.stop();
    return queue.start();
  });
  ipcMain.handle(IPC.stopQueue, () => queue.stop());
  ipcMain.handle(IPC.showInFolder, (_e, pathIn: unknown) => {
    const p = pathArg(pathIn);
    if (p) shell.showItemInFolder(p);
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
  protocol.handle(MEDIA_SCHEME, (req) => {
    const file = decodeURIComponent(new URL(req.url).pathname.slice(1));
    if (!resolve(file).startsWith(mediaDir + sep)) return new Response("not found", { status: 404 });
    // loop: NOT-WORTH — one local file per media request (thumbnails / stills from the app's cache) [bounded: a local file: URL]
    return net.fetch(pathToFileURL(file).toString());
  });
  // one copy runs (single-instance lock) and no engine yet: any job folder is left over from a crash
  clearJobTemps(join(cacheDir, "jobs"));
  // stills older than 30 days, or past 500 MB, go (storage.ts)
  pruneCache(mediaDir);
  nativeTheme.themeSource = settings.appearance.theme === "light" ? "light" : settings.appearance.theme === "dark" ? "dark" : "system";
  updatePaletteWatch();
  registerIpc();
  createWindow();
  updater.start();
});

app.on("before-quit", () => {
  queue.shutdown();
  estimator.stop();
  stopPaletteWatch?.();
  updater.stop();
});
app.on("window-all-closed", () => app.quit());
// The DS5 app's AppImage mount guard: keeps the mount until the process is gone, so quitting never crashes on the way out.
app.on("will-quit", () => holdAppImageMountUntilExit());
