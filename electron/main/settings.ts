// Settings file (userData/settings.json) and the Rust engine's setup check.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { CheckoutCheck, Settings } from "../../src/shared/types";
import { sanitizeAppearance, sanitizeOptions, vramLimit } from "./validate";
import { sanitizeTrtSizes } from "../../src/shared/trt";
import { READ_ONLY, VALUE_MAX, VAR_NAME } from "../../src/shared/console/vars";

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
    consoleWriteFolders: writeFolders(saved.consoleWriteFolders),
    consoleBookmarks: bookmarks(saved.consoleBookmarks),
    consoleVariables: variables(saved.consoleVariables),
  };
}

/** The Console's allowed folders as saved: absolute paths only, each once, at most WRITE_FOLDERS_MAX (a hand-edited
 * file can't widen the scope with a relative path or a non-string). */
export const WRITE_FOLDERS_MAX = 100;
function writeFolders(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  // loop: NOT-WORTH — ≤ a hundred folders, once at start
  return [...new Set(v.filter((p): p is string => typeof p === "string" && p !== "" && !p.includes("\0") && isAbsolute(p)))].slice(0, WRITE_FOLDERS_MAX);
}

/** A Console bookmark's name (`cd @sh010`): a letter or digit, then letters, digits, _ . - (never a frame token's @@). */
export const BOOKMARK_NAME = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,63}$/u;
export const BOOKMARKS_MAX = 200;
/** The Console's bookmarks as saved: valid names to absolute folders only, at most BOOKMARKS_MAX (a hand-edited file
 * can't add a relative path or a name `cd @…` can't reach). */
function bookmarks(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  // loop: NOT-WORTH — ≤ a few hundred bookmarks, once at start
  const ok = Object.entries(v as Record<string, unknown>).filter(
    (e): e is [string, string] => BOOKMARK_NAME.test(e[0]) && typeof e[1] === "string" && e[1] !== "" && !e[1].includes("\0") && isAbsolute(e[1]),
  );
  return Object.fromEntries(ok.slice(0, BOOKMARKS_MAX));
}

export const VARIABLES_MAX = 200;
/** The Console's kept variables (`set -p`): valid names (never a read-only one), strings without NUL, at most
 * VALUE_MAX long and VARIABLES_MAX of them. */
function variables(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  // loop: NOT-WORTH — ≤ a few hundred variables, once at start
  const ok = Object.entries(v as Record<string, unknown>).filter(
    (e): e is [string, string] => VAR_NAME.test(e[0]) && !(READ_ONLY as readonly string[]).includes(e[0]) && typeof e[1] === "string" && e[1].length <= VALUE_MAX && !e[1].includes("\0"),
  );
  return Object.fromEntries(ok.slice(0, VARIABLES_MAX));
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
