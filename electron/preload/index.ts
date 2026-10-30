// Sandboxed preload: the page's only door to the main process. One function
// per IPC channel; the IPC object itself is never handed to the page.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { IPC } from "../main/ipc";
import type { AppState, ConsoleBlock, CorridorKeyApi } from "../../src/shared/types";

const api: CorridorKeyApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  onState: (listener) => {
    const handler = (_e: IpcRendererEvent, state: AppState) => listener(state);
    // lifetime: OK — removed by the unsubscribe it returns
    ipcRenderer.on(IPC.state, handler);
    return () => ipcRenderer.removeListener(IPC.state, handler);
  },
  addPaths: (paths) => ipcRenderer.invoke(IPC.addPaths, paths),
  pickClips: (kind) => ipcRenderer.invoke(IPC.pickClips, kind),
  pickFile: (kind) => ipcRenderer.invoke(IPC.pickFile, kind),
  pickRustEngine: (what) => ipcRenderer.invoke(IPC.pickRustEngine, what),
  setRustEngine: (what, path) => ipcRenderer.invoke(IPC.setRustEngine, what, path),
  installFfmpeg: () => ipcRenderer.invoke(IPC.installFfmpeg),
  startInstall: (part) => ipcRenderer.invoke(IPC.startInstall, part),
  stopInstall: () => ipcRenderer.invoke(IPC.stopInstall),
  setTensorrt: (on) => ipcRenderer.invoke(IPC.setTensorrt, on),
  setModelSet: (name) => ipcRenderer.invoke(IPC.setModelSet, name),
  trtPrebuild: (action, picks) => ipcRenderer.invoke(IPC.trtPrebuild, action, picks),
  trtSize: (action, size) => ipcRenderer.invoke(IPC.trtSize, action, size),
  measureStorage: () => ipcRenderer.invoke(IPC.measureStorage),
  removeStorage: (id) => ipcRenderer.invoke(IPC.removeStorage, id),
  openStorageFolder: (id) => ipcRenderer.invoke(IPC.openStorageFolder, id),
  pickCacheFolder: (to) => ipcRenderer.invoke(IPC.pickCacheFolder, to),
  setVramLimitDefault: (gb) => ipcRenderer.invoke(IPC.setVramLimitDefault, gb),
  pathForFile: (file) => webUtils.getPathForFile(file),
  setJobOptions: (id, options) => ipcRenderer.invoke(IPC.setJobOptions, id, options),
  estimateMemory: (id) => ipcRenderer.invoke(IPC.estimateMemory, id),
  removeJob: (id) => ipcRenderer.invoke(IPC.removeJob, id),
  retryJob: (id) => ipcRenderer.invoke(IPC.retryJob, id),
  startQueue: () => ipcRenderer.invoke(IPC.startQueue),
  stopQueue: () => ipcRenderer.invoke(IPC.stopQueue),
  showInFolder: (path) => ipcRenderer.invoke(IPC.showInFolder, path),
  copyText: (text) => ipcRenderer.invoke(IPC.copyText, text),
  copyJobLog: (id) => ipcRenderer.invoke(IPC.copyJobLog, id),
  setVisible: (visible) => ipcRenderer.send(IPC.setVisible, visible),
  setAppearance: (a) => ipcRenderer.invoke(IPC.setAppearance, a),
  pickOutputRoot: () => ipcRenderer.invoke(IPC.pickOutputRoot),
  clearOutputRoot: () => ipcRenderer.invoke(IPC.clearOutputRoot),
  checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates),
  setUpdateChannel: (c) => ipcRenderer.invoke(IPC.setUpdateChannel, c),
  setAutoUpdate: (on) => ipcRenderer.invoke(IPC.setAutoUpdate, on),
  installUpdate: () => ipcRenderer.invoke(IPC.installUpdate),
  restartToUpdate: () => ipcRenderer.invoke(IPC.restartToUpdate),
  backToStable: () => ipcRenderer.invoke(IPC.backToStable),
  consoleRun: (line) => ipcRenderer.invoke(IPC.consoleRun, line),
  consoleRunLines: (lines) => ipcRenderer.invoke(IPC.consoleRunLines, lines),
  consoleCancel: () => ipcRenderer.invoke(IPC.consoleCancel),
  consoleComplete: (line, cursor) => ipcRenderer.invoke(IPC.consoleComplete, line, cursor),
  consoleHistory: (query) => ipcRenderer.invoke(IPC.consoleHistory, query),
  consoleElevationDrop: () => ipcRenderer.invoke(IPC.consoleElevationDrop),
  consoleDisallow: (folder) => ipcRenderer.invoke(IPC.consoleDisallow, folder),
  onConsoleBlocks: (listener) => {
    const handler = (_e: IpcRendererEvent, blocks: ConsoleBlock[]) => listener(blocks);
    // lifetime: OK — removed by the unsubscribe it returns
    ipcRenderer.on(IPC.consoleBlocks, handler);
    return () => ipcRenderer.removeListener(IPC.consoleBlocks, handler);
  },
};

contextBridge.exposeInMainWorld("ck", api);
