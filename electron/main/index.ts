// CorridorKey desktop: main process. One window, one queue, one engine.
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, shell } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EngineProcess } from "./engine";
import { GPU_POLL_MS, readGpu } from "./gpu";
import { expandPaths, probeClip, still, STILL_WIDTH, VIDEO_EXT } from "./media";
import { Queue } from "./queue";
import { checkCheckout, loadSettings, saveSettings } from "./settings";
import { readDesktopPalette, watchDesktopPalette } from "./desktopTheme";
import { Updater } from "./updater";
import type { Appearance, AppState, GpuInfo, Job, JobOptions, OutputName } from "../../src/shared/types";
import type { DesktopPalette } from "../../src/ui/theme/palette";
import { IPC } from "./ipc";

const here = dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env.ELECTRON_RENDERER_URL;
const MEDIA_SCHEME = "ck-media";

// Must run before app ready. NVIDIA + Wayland: Electron's GPU process crash-loops
// (SIGTRAP) on this driver line; X11 with the GPU sandbox off is the known fix
// (rule 13: platform quirks handled).
function applyLinuxWorkarounds(): void {
  if (process.platform !== "linux") return;
  const wayland = process.env.XDG_SESSION_TYPE === "wayland" || Boolean(process.env.WAYLAND_DISPLAY);
  if (wayland && existsSync("/proc/driver/nvidia/version")) {
    app.commandLine.appendSwitch("ozone-platform", "x11");
    app.commandLine.appendSwitch("disable-gpu-sandbox");
  }
}
applyLinuxWorkarounds();
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } }]);

const settingsFile = join(app.getPath("userData"), "settings.json");
// Disk, not /tmp (it is RAM on many Linux desktops): XDG cache, else ~/.cache.
const cacheDir = join(process.env.XDG_CACHE_HOME || join(app.getPath("home"), ".cache"), "corridorkey-desktop");
const mediaDir = join(cacheDir, "media");
let settings = loadSettings(settingsFile, process.env);
let checkout = checkCheckout(settings.corridorKeyRoot);
let mainWindow: BrowserWindow | null = null;
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

const queue = new Queue({
  makeEngine: (onReply, onExit) => {
    const root = settings.corridorKeyRoot!;
    return new EngineProcess({ python: join(root, "venv", "bin", "python"), script: engineScript(), packageRoot: root, env: process.env }, onReply, onExit);
  },
  tempDirFor: (id) => join(cacheDir, "jobs", id),
  changed: () => scheduleSend(),
  finished: (job) => void makeStills(job),
});

function state(): AppState {
  return {
    version: app.getVersion(),
    jobs: queue.jobs,
    queueRunning: queue.running,
    engine: queue.engine,
    gpu,
    gpuError,
    settings,
    checkout,
    desktopPalette,
    update: updater.state,
  };
}

// State goes to the page at most every 100 ms (frames already arrive ≤ 4/s).
let sendTimer: NodeJS.Timeout | null = null;
function scheduleSend(): void {
  updateGpuPolling();
  if (sendTimer) return;
  sendTimer = setTimeout(() => {
    sendTimer = null;
    mainWindow?.webContents.send(IPC.state, state());
  }, 100);
}

// GPU readout: polled only while a job runs AND the window is shown (rule 3).
async function pollGpu(): Promise<void> {
  try {
    const pid = queue.enginePid;
    gpu = await readGpu(new Set(pid ? [pid] : []));
    gpuError = null;
  } catch (e) {
    // error: SHOWN — the GPU card says nvidia-smi couldn't be read
    gpuError = e instanceof Error ? e.message.split("\n")[0] : String(e);
  }
  scheduleSend();
}

function updateGpuPolling(): void {
  const want = windowShown && queue.running;
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
    const file = job.outputs.find((f) => basename(f).includes(`_${output === "checker" ? "checker_comp" : output}`));
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
      outputDir: outputDirFor(parent, clip.name),
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
  ipcMain.handle(IPC.addPaths, (_e, paths: string[]) => addPaths(paths.filter((p) => typeof p === "string")));
  ipcMain.handle(IPC.pickClips, async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: "Add clips",
      properties: ["openFile", "openDirectory", "multiSelections"],
      filters: [{ name: "Video", extensions: [...VIDEO_EXT].map((e) => e.slice(1)) }],
    });
    if (!r.canceled) await addPaths(r.filePaths);
  });
  ipcMain.handle(IPC.pickFile, async (_e, kind: "hint-image" | "hint-video") => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: kind === "hint-image" ? "First-frame hint (matte image)" : "Hint video or frame folder",
      properties: kind === "hint-image" ? ["openFile"] : ["openFile", "openDirectory"],
      filters: kind === "hint-image" ? [{ name: "Matte image", extensions: ["png", "jpg", "jpeg", "exr"] }] : [{ name: "Video", extensions: [...VIDEO_EXT].map((e) => e.slice(1)) }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle(IPC.pickCheckout, async () => {
    const r = await dialog.showOpenDialog(mainWindow!, { title: "Your CorridorKey2.0 folder", properties: ["openDirectory"] });
    if (r.canceled) return;
    settings = { ...settings, corridorKeyRoot: r.filePaths[0] };
    checkout = checkCheckout(settings.corridorKeyRoot);
    persist();
    scheduleSend();
  });
  ipcMain.handle(IPC.setJobOptions, (_e, id: string, options: JobOptions) => {
    queue.setOptions(id, options);
    settings = { ...settings, lastOptions: { ...options, hintFirstFrame: null, hintVideo: null, hintMode: "none" } };
    persist();
  });
  ipcMain.handle(IPC.removeJob, (_e, id: string) => queue.remove(id));
  ipcMain.handle(IPC.retryJob, (_e, id: string) => queue.retry(id));
  ipcMain.handle(IPC.startQueue, () => {
    checkout = checkCheckout(settings.corridorKeyRoot);
    if (!checkout.ok) return scheduleSend();
    return queue.start();
  });
  ipcMain.handle(IPC.stopQueue, () => queue.stop());
  ipcMain.handle(IPC.showInFolder, (_e, path: string) => shell.showItemInFolder(path));
  ipcMain.handle(IPC.setAppearance, (_e, a: Appearance) => {
    settings = { ...settings, appearance: { theme: a.theme, accent: a.accent, glass: Boolean(a.glass) } };
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
  ipcMain.handle(IPC.setUpdateChannel, (_e, c: "stable" | "dev") => updater.setChannel(c === "dev" ? "dev" : "stable"));
  ipcMain.handle(IPC.setAutoUpdate, (_e, on: boolean) => updater.setAutomatic(Boolean(on)));
  ipcMain.handle(IPC.installUpdate, () => updater.download());
  ipcMain.handle(IPC.restartToUpdate, () => updater.restart());
  ipcMain.on(IPC.setVisible, (_e, visible: boolean) => {
    windowShown = Boolean(visible);
    updateGpuPolling();
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
    title: "CorridorKey",
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
  const shown = (v: boolean) => () => {
    windowShown = v;
    updateGpuPolling();
  };
  mainWindow.on("show", shown(true));
  mainWindow.on("restore", shown(true));
  mainWindow.on("hide", shown(false));
  mainWindow.on("minimize", shown(false));
  mainWindow.on("closed", () => {
    mainWindow = null;
    windowShown = false;
    updateGpuPolling();
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

app.whenReady().then(() => {
  protocol.handle(MEDIA_SCHEME, (req) => {
    const file = decodeURIComponent(new URL(req.url).pathname.slice(1));
    if (!resolve(file).startsWith(mediaDir + "/")) return new Response("not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  nativeTheme.themeSource = settings.appearance.theme === "light" ? "light" : settings.appearance.theme === "dark" ? "dark" : "system";
  updatePaletteWatch();
  registerIpc();
  createWindow();
  updater.start();
});

app.on("before-quit", () => {
  queue.shutdown();
  stopPaletteWatch?.();
  updater.stop();
});
app.on("window-all-closed", () => app.quit());
