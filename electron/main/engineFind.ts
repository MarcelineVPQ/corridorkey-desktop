// Finds the Rust engine's files on this computer, for the Engine page's lists
// (Marcy 2026-10-23: choose from a list, not only a file browser). Places looked at:
//   engine program: the copy inside the app (packaged), else engine-rs/target/release (a dev build);
//   models: <data>/models/<version>/ (one folder per model set, with its manifest.json);
//   ONNX Runtime: <data>/runtime/<name>/onnxruntime/capi/libonnxruntime.so.<version> (a pip-wheel
//     layout, so the CUDA libraries next to it are found the same way: engine.ts rustEngineEnv).
// <data> is $XDG_DATA_HOME/corridorkey-desktop (~/.local/share/corridorkey-desktop): the in-app install
// (BACKLOG row 2) puts its downloads there. Newest first. A setting of null means "Automatic": the first
// one found.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

export function dataDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "corridorkey-desktop");
}

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
function versionKey(v: string): number[] {
  // loop: NOT-WORTH — a few version parts
  return v.split(".").map((n) => Number.parseInt(n, 10) || 0);
}
function newerFirst(a: number[], b: number[]): number {
  // loop: NOT-WORTH — a few version parts
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
  return 0;
}

export function findEngineFiles(places: { bundledBinary: string | null; devBinary: string | null; data: string }, d: FindDeps = realDeps): EngineFiles {
  const binary: EngineFileChoice[] = [];
  if (places.bundledBinary && d.exists(places.bundledBinary)) binary.push({ path: places.bundledBinary, label: "Included with the app" });
  if (places.devBinary && d.exists(places.devBinary)) binary.push({ path: places.devBinary, label: "Development build (engine-rs)" });

  const models: (EngineFileChoice & { created: string })[] = [];
  const modelsRoot = join(places.data, "models");
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
  const runtimeRoot = join(places.data, "runtime");
  // loop: NOT-WORTH — one folder per installed runtime (one or two)
  for (const name of dirs(runtimeRoot, d)) {
    const capi = join(runtimeRoot, name, "onnxruntime", "capi");
    // loop: NOT-WORTH — a dozen files in ONNX Runtime's capi folder
    const lib = dirs(capi, d).find((f) => /^libonnxruntime\.so\.\d/.test(f));
    if (!lib) continue;
    const version = lib.slice("libonnxruntime.so.".length);
    const gpu = d.exists(join(capi, "libonnxruntime_providers_cuda.so"));
    ort.push({ path: join(capi, lib), label: `ONNX Runtime ${version}${gpu ? " (graphics card)" : " (CPU only)"}`, key: versionKey(version) });
  }
  // loop: NOT-WORTH — sorts one or two runtimes
  ort.sort((a, b) => newerFirst(a.key, b.key));

  // loop: NOT-WORTH — strips the sort keys from a few entries
  return { binary, models: models.map(({ path, label }) => ({ path, label })), ort: ort.map(({ path, label }) => ({ path, label })) };
}

/** A path inside the running AppImage's mount (resources/…): it changes every launch, so it is never saved. */
export function isInsideApp(path: unknown, resourcesPath: string | null): boolean {
  return typeof path === "string" && ((!!resourcesPath && path.startsWith(resourcesPath + "/")) || /\/\.mount_[^/]+\//.test(path));
}

/** What the engine runs with: the chosen path, else (Automatic) the first one found. */
export function effectivePath(setting: string | null, found: EngineFileChoice[]): string | null {
  return setting ?? found[0]?.path ?? null;
}
