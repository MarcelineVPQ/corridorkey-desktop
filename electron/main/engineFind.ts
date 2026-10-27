// Finds the Rust engine's files on this computer, for the Engine page's lists
// (Marcy 2026-10-23: choose from a list, not only a file browser). Places looked at:
//   engine program: the copy inside the app (packaged), else engine-rs/target/release (a dev build);
//   models: <data>/models/<version>/ (one folder per model set, with its manifest.json);
//   ONNX Runtime: <data>/runtime/<name>/onnxruntime/capi/libonnxruntime.so.<version> (a pip-wheel
//     layout, so the CUDA libraries next to it are found the same way: engine.ts rustEngineEnv).
// <data> is $XDG_DATA_HOME/corridorkey-desktop (~/.local/share/corridorkey-desktop): the in-app install
// (BACKLOG row 2) puts its downloads there. Newest first. A setting of null means "Automatic": the first
// one found.
import { isAppImageMount } from "./relaunch";
import { isWin, MODELS_DIR, ortLibrary, PLATFORM, RUNTIME_DIR } from "./platform";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EngineFileChoice, EngineFiles } from "../../src/shared/types";

export interface FindDeps {
  exists: (p: string) => boolean;
  list: (p: string) => string[];
  read: (p: string) => string;
}

const realDeps: FindDeps = {
  exists: existsSync,
  // loop: NOT-WORTH — lists the models / runtime folders (a few entries), once per Engine check
  list: (p) => readdirSync(p),
  // loop: NOT-WORTH — reads one small manifest.json per model set, once per Engine check
  read: (p) => readFileSync(p, "utf8"),
};

function dirs(p: string, d: FindDeps): string[] {
  try {
    // a name starting with "." is an install still in progress (.partial-…): never offered
    // loop: NOT-WORTH — sorts a few folder names
    return d
      .list(p)
      .filter((n) => !n.startsWith("."))
      .sort();
  } catch {
    // error: NOT-WORTH — no such folder yet (nothing installed): nothing found there
    return [];
  }
}

/** "1.31.0" from libonnxruntime.so.1.31.0, compared numerically. */
function numericVersionKey(v: string): number[] {
  // loop: NOT-WORTH — a few version parts
  return v.split(".").map((n) => Number.parseInt(n, 10) || 0);
}
function newerFirst(a: number[], b: number[]): number {
  // loop: NOT-WORTH — a few version parts
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
  return 0;
}

export function findEngineFiles(places: { bundledBinary: string | null; devBinary: string | null; data: string }, d: FindDeps = realDeps, platform: NodeJS.Platform = PLATFORM): EngineFiles {
  const binary: EngineFileChoice[] = [];
  if (places.bundledBinary && d.exists(places.bundledBinary)) binary.push({ path: places.bundledBinary, label: "Included with the app" });
  if (places.devBinary && d.exists(places.devBinary)) binary.push({ path: places.devBinary, label: "Development build (engine-rs)" });

  const models: (EngineFileChoice & { created: string })[] = [];
  const modelsRoot = join(places.data, MODELS_DIR);
  // loop: NOT-WORTH — one folder per installed model set (one or two)
  for (const name of dirs(modelsRoot, d)) {
    const dir = join(modelsRoot, name);
    if (!d.exists(join(dir, "models.json"))) continue;
    let version = name;
    let created = "";
    let precisions: string[] = [];
    try {
      const m = JSON.parse(d.read(join(dir, "manifest.json"))) as { version?: string; created?: string; models?: { precision?: string }[] };
      version = m.version ?? name;
      created = m.created ?? "";
      // loop: NOT-WORTH — ten models per manifest
      precisions = [...new Set((m.models ?? []).map((x) => x.precision).filter((p): p is string => !!p))].sort();
    } catch {
      // error: SHOWN — no readable manifest: listed under its folder name, without precisions
    }
    models.push({ path: dir, label: precisions.length ? `${version} (${precisions.join(" + ")})` : version, created });
  }
  // loop: NOT-WORTH — sorts one or two model sets
  models.sort((a, b) => b.created.localeCompare(a.created) || b.label.localeCompare(a.label));

  const ort: (EngineFileChoice & { key: number[] })[] = [];
  const runtimeRoot = join(places.data, RUNTIME_DIR);
  // loop: NOT-WORTH — one folder per installed runtime (one or two)
  for (const name of dirs(runtimeRoot, d)) {
    const capi = join(runtimeRoot, name, "onnxruntime", "capi");
    const o = ortLibrary(platform);
    // loop: NOT-WORTH — a dozen files in ONNX Runtime's capi folder
    const lib = dirs(capi, d).find((f) => o.match.test(f));
    // Windows' library name has no version: it comes from the wheel's kept dist-info folder (onnxruntime_gpu-1.31.0.dist-info)
    const fromDistInfo = () =>
      dirs(join(runtimeRoot, name), d)
        // loop: NOT-WORTH — a few folders in one runtime
        .map((f) => /^onnxruntime(?:_gpu)?-([\d.]+)\.dist-info$/.exec(f)?.[1])
        // loop: NOT-WORTH — as above
        .find(Boolean);
    const version = lib && (o.version(lib) ?? fromDistInfo());
    // macOS: Core ML (Apple's GPU and Neural Engine) is built into the library
    const gpu = o.cudaProvider === null || d.exists(join(capi, o.cudaProvider));
    if (!lib || !version) continue;
    ort.push({ path: join(capi, lib), label: `ONNX Runtime ${version}${gpu ? " (graphics card)" : " (CPU only)"}`, key: numericVersionKey(version) });
  }
  // loop: NOT-WORTH — sorts one or two runtimes
  ort.sort((a, b) => newerFirst(a.key, b.key));

  // loop: NOT-WORTH — strips the sort keys from a few entries
  return { binary, models: models.map(({ path, label }) => ({ path, label })), ort: ort.map(({ path, label }) => ({ path, label })) };
}

/** TensorRT's engine builder's file name (Linux only in 1.0). */
export const TRT_BUILDER = "ck-trt-build";

/**
 * ck-trt-build for the engine at `binary`: next to it (the AppImage ships both in resources/engine), else the release
 * build's copy (tools/build_trt_builder.sh, engine-rs/target/dist) for a development engine. null: none, and a
 * TensorRT job's networks run on CUDA, saying why.
 */
export function findTrtBuilder(binary: string | null, distDir: string | null, exists: (p: string) => boolean = existsSync): string | null {
  return besideEngine(TRT_BUILDER, binary, distDir, exists);
}

/** `name` next to the engine at `binary`, else in `distDir` (the release build's folder), or null. */
function besideEngine(name: string, binary: string | null, distDir: string | null, exists: (p: string) => boolean): string | null {
  // loop: NOT-WORTH — two candidates, two stats per lookup
  return [binary ? join(dirname(binary), name) : null, distDir ? join(distDir, name) : null].find((p): p is string => !!p && exists(p)) ?? null;
}

/**
 * The command line (`corridorkey`, ck-cli; docs/CLI.md) that ships next to the engine (resources/engine), for the
 * Console: beside the engine at `binary` (a dev engine's target/release has it too), else the release build's copy
 * (engine-rs/target/dist). null: none found.
 */
export function findCli(binary: string | null, distDir: string | null, exists: (p: string) => boolean = existsSync, platform: NodeJS.Platform = PLATFORM): string | null {
  return besideEngine(isWin(platform) ? "corridorkey.exe" : "corridorkey", binary, distDir, exists);
}

/** A path inside the running AppImage's mount (resources/…): it changes every launch, so it is never saved. */
export function isInsideApp(path: unknown, resourcesPath: string | null): boolean {
  return typeof path === "string" && ((!!resourcesPath && (path.startsWith(resourcesPath + "/") || path.startsWith(resourcesPath + "\\"))) || isAppImageMount(path));
}

/** The model set's version from its manifest.json ("2.0.0-onnx.3"), or null. */
export function modelSetVersion(dir: string | null, d: FindDeps = realDeps): string | null {
  if (!dir) return null;
  try {
    return (JSON.parse(d.read(join(dir, "manifest.json"))) as { version?: string }).version ?? null;
  } catch {
    // error: NOT-WORTH — no readable manifest: the title leaves the version out
    return null;
  }
}

/**
 * The window title: CorridorKey's own version (the model set's major.minor: 2.0.0-onnx.3 is CorridorKey 2.0, and it
 * follows when Corridor updates the model) and the engine, so it is clear this isn't Corridor's original (Marcy
 * 2026-10-24: "CorridorKey 2.0 — Rust + ONNX").
 */
export function windowTitle(modelsVersion: string | null): string {
  const v = modelsVersion ? /^(\d+\.\d+)/.exec(modelsVersion)?.[1] : undefined;
  return `CorridorKey${v ? ` ${v}` : ""} — Rust + ONNX`;
}

/** What the engine runs with: the chosen path, else (Automatic) the first one found. */
export function effectivePath(setting: string | null, found: EngineFileChoice[]): string | null {
  return setting ?? found[0]?.path ?? null;
}
