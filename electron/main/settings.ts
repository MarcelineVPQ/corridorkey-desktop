// Settings file (userData/settings.json) and the Rust engine's setup check.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { CheckoutCheck, Settings } from "../../src/shared/types";
import { sanitizeAppearance, sanitizeOptions, vramLimit } from "./validate";
import { sanitizeTrtSizes } from "../../src/shared/trt";

export function loadSettings(file: string): Settings {
  let saved: Partial<Settings> = {};
  try {
    // loop: NOT-WORTH — reads the settings file (a few KB) once at start
    saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Settings>;
  } catch {
    // error: NOT-WORTH — no file yet (first start) or unreadable: start from the defaults
  }
  // an older or hand-edited file: every value checked (an unknown output name or a bad window would fail every job)
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};
  const path = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return {
    lastOptions: sanitizeOptions(saved.lastOptions),
    appearance: sanitizeAppearance(saved.appearance),
    outputRoot: path(saved.outputRoot),
    // the saved choices only: CK_ENGINE_BIN / _MODELS / _ORT override them at run time (index.ts enginePaths) and are
    // never written back (a test override used to stick in settings.json after the variable was gone)
    engineBinary: path(saved.engineBinary),
    modelsDir: path(saved.modelsDir),
    ortLibrary: path(saved.ortLibrary),
    tensorrt: saved.tensorrt === true,
    vramLimitGb: vramLimit(saved.vramLimitGb),
    // the sizes TensorRT builds for (row 56); absent: 4K DCI and HD, what the background build always did
    trtSizes: sanitizeTrtSizes(saved.trtSizes),
    // an absolute folder only (anything else: the system's cache folder)
    cacheRoot: typeof saved.cacheRoot === "string" && isAbsolute(saved.cacheRoot) ? saved.cacheRoot : null,
  };
}

/** The five networks the Rust engine runs (engine-rs runtime.rs PIECES). */
export const MODEL_PIECES = ["cradio", "moge", "rvm", "stage1", "stage2"] as const;

/**
 * The Rust engine: its program and the models folder (one <piece>_….onnx per network, or a models.json).
 * The engine itself checks the exact files and precision and says so in its pong ("assets").
 */
// loop: NOT-WORTH — a few stats + one readdir per Engine-page check (when the paths are set)
export function checkRustEngine(
  binary: string | null,
  models: string | null,
  ort: string | null = null,
  exists: (p: string) => boolean = existsSync,
  list: (p: string) => string[] = (p) => readdirSync(p),
): CheckoutCheck {
  const problems: string[] = [];
  // the engine loads ONNX Runtime at run time (the GPU build): a missing library would only fail at Start
  if (ort && !exists(ort)) problems.push(`Missing ${ort}: ONNX Runtime's library.`);
  if (!binary) problems.push("Choose the CorridorKey engine program (corridorkey-engine).");
  else if (!exists(binary)) problems.push(`Missing ${binary}: the engine program.`);
  if (!models) problems.push("Choose the folder with the CorridorKey ONNX models.");
  else if (!exists(models)) problems.push(`Missing ${models}: the models folder.`);
  else if (!exists(join(models, "models.json"))) {
    let files: string[] = [];
    try {
      files = list(models);
    } catch {
      // error: SHOWN — an unreadable folder lists every network as missing below
    }
    // loop: NOT-WORTH — five networks × the models folder's files, once per check
    const missing = MODEL_PIECES.filter((p) => !files.some((f) => f.endsWith(".onnx") && (f.startsWith(`${p}_`) || f.startsWith(`${p}.`))));
    if (missing.length) problems.push(`The models folder has no ${missing.join(", ")} network${missing.length > 1 ? "s" : ""}.`);
  }
  return { ok: problems.length === 0, problems };
}

/** Write atomically (temp file + rename) so a crash never leaves half a file. */
export function saveSettings(file: string, settings: Settings): void {
  // loop: NOT-WORTH — one mkdir per settings save (a user action)
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // loop: NOT-WORTH — writes the settings file (a few KB) per save
  writeFileSync(tmp, JSON.stringify(settings, null, 2));
  // loop: NOT-WORTH — one rename per save (atomic replace)
  renameSync(tmp, file);
}
