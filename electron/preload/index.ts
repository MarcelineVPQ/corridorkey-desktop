// Sandboxed preload: the page's only door to the main process. One function
// per IPC channel; the IPC object itself is never handed to the page.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { IPC } from "../main/ipc";
import type { AppState, CorridorKeyApi } from "../../src/shared/types";

const api: CorridorKeyApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  onState: (listener) => {
    const handler = (_e: IpcRendererEvent, state: AppState) => listener(state);
    // lifetime: OK — removed by the unsubscribe it returns
    ipcRenderer.on(IPC.state, handler);
    return () => ipcRenderer.removeListener(IPC.state, handler);
  },
  addPaths: (paths) => ipcRenderer.invoke(IPC.addPaths, paths),
  pickClips: () => ipcRenderer.invoke(IPC.pickClips),
  pickFile: (kind) => ipcRenderer.invoke(IPC.pickFile, kind),
  pickCheckout: () => ipcRenderer.invoke(IPC.pickCheckout),
  pickRustEngine: (what) => ipcRenderer.invoke(IPC.pickRustEngine, what),
  pathForFile: (file) => webUtils.getPathForFile(file),
  setJobOptions: (id, options) => ipcRenderer.invoke(IPC.setJobOptions, id, options),
  removeJob: (id) => ipcRenderer.invoke(IPC.removeJob, id),
  retryJob: (id) => ipcRenderer.invoke(IPC.retryJob, id),
  startQueue: () => ipcRenderer.invoke(IPC.startQueue),
  stopQueue: () => ipcRenderer.invoke(IPC.stopQueue),
  showInFolder: (path) => ipcRenderer.invoke(IPC.showInFolder, path),
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
};

contextBridge.exposeInMainWorld("ck", api);
