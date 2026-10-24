// What differs per operating system, in one place (the de-duplication pass 2026-10-24: these rules were spread
// over engineFind, index, engine, install and the Engine page, and a .dylib missing from one of four copies
// broke the macOS install). Pure functions take the platform as an argument (tests fake one); the app passes
// PLATFORM. GPU vendors (NVIDIA today, Apple's Core ML next, AMD maybe) are not decided here: install.ts
// systemSupport says what this system can run.
import { delimiter as pathDelimiter, join } from "node:path";

export const PLATFORM: NodeJS.Platform = process.platform;
export const isWin = (p: NodeJS.Platform = PLATFORM) => p === "win32";
export const isMac = (p: NodeJS.Platform = PLATFORM) => p === "darwin";

/** The app's folder name under each system's data and cache roots. */
export const APP_DIR = "corridorkey-desktop";
/** The data folder's parts: the downloaded GPU runtime, the models, and the downloads in progress. */
export const RUNTIME_DIR = "runtime";
export const MODELS_DIR = "models";
export const DOWNLOADS_DIR = "downloads";

/**
 * Where the app keeps its data (runtime, models) and its cache (thumbnails, stills): Linux $XDG_DATA_HOME /
 * $XDG_CACHE_HOME (else ~/.local/share, ~/.cache), Windows %LOCALAPPDATA%\corridorkey-desktop (cache in its
 * "cache" folder), macOS ~/Library/Application Support and ~/Library/Caches. Never /tmp (RAM on many Linux
 * desktops). The Windows uninstaller (build/installer.nsh) names the same folders.
 */
export function appDirs(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform = PLATFORM): { data: string; cache: string } {
  if (isWin(platform)) {
    const root = join(env.LOCALAPPDATA || join(home, "AppData", "Local"), APP_DIR);
    return { data: root, cache: join(root, "cache") };
  }
  if (isMac(platform)) return { data: join(home, "Library", "Application Support", APP_DIR), cache: join(home, "Library", "Caches", APP_DIR) };
  return { data: join(env.XDG_DATA_HOME || join(home, ".local", "share"), APP_DIR), cache: join(env.XDG_CACHE_HOME || join(home, ".cache"), APP_DIR) };
}

/** The engine program's file name. */
export function engineBinName(platform: NodeJS.Platform = PLATFORM): string {
  return isWin(platform) ? "corridorkey-engine.exe" : "corridorkey-engine";
}

/** ONNX Runtime's library on each system, as the wheels name it, and how its name carries the version. */
export interface OrtLibrary {
  // how people (and file dialogs) call it
  display: string;
  // the file in the runtime's onnxruntime/capi folder; version from its name (Windows: from the dist-info folder)
  match: RegExp;
  version(file: string): string | undefined;
  // present when the runtime can use NVIDIA's graphics cards (macOS: Core ML is built into the library)
  cudaProvider: string | null;
}

export function ortLibrary(platform: NodeJS.Platform = PLATFORM): OrtLibrary {
  if (isWin(platform)) return { display: "onnxruntime.dll", match: /^onnxruntime\.dll$/, version: () => undefined, cudaProvider: "onnxruntime_providers_cuda.dll" };
  if (isMac(platform)) return { display: "libonnxruntime.dylib", match: /^libonnxruntime\.\d[\d.]*\.dylib$/, version: (f) => f.slice("libonnxruntime.".length, -".dylib".length), cudaProvider: null };
  return { display: "libonnxruntime.so", match: /^libonnxruntime\.so\.\d/, version: (f) => f.slice("libonnxruntime.so.".length), cudaProvider: "libonnxruntime_providers_cuda.so" };
}

/** A shared library on any system (a wheel must give at least one: licence files alone don't count). */
export const LIBRARY_FILE = /\.(so[.\d]*|dll|dylib)$/;

/**
 * Add folders to a PATH-style list (`front`: searched first, as winget's ffmpeg and the engine's libraries;
 * `back`: after the user's own, as Homebrew's), each folder once, with the system's separator.
 */
export function addToPathList(list: string | undefined, dirs: string[], where: "front" | "back", sep: string = pathDelimiter): string {
  // loop: NOT-WORTH — a few folders, once per check or engine start
  const have = (list ?? "").split(sep).filter(Boolean);
  // loop: NOT-WORTH — as above
  const add = dirs.filter((d, i) => d && !have.includes(d) && dirs.indexOf(d) === i);
  return (where === "front" ? [...add, ...have] : [...have, ...add]).join(sep);
}
