// Settings file (userData/settings.json) and the CorridorKey checkout check.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CheckoutCheck, EngineKind, Settings } from "../../src/shared/types";
import { sanitizeAppearance, sanitizeOptions } from "./validate";

export function loadSettings(file: string, env: NodeJS.ProcessEnv): Settings {
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
    corridorKeyRoot: env.CK_PACKAGE_ROOT || path(saved.corridorKeyRoot),
    lastOptions: sanitizeOptions(saved.lastOptions),
    appearance: sanitizeAppearance(saved.appearance),
    outputRoot: path(saved.outputRoot),
    engineBinary: env.CK_ENGINE_BIN || path(saved.engineBinary),
    modelsDir: env.CK_ENGINE_MODELS || path(saved.modelsDir),
    ortLibrary: env.CK_ENGINE_ORT || path(saved.ortLibrary),
  };
}

/** The five networks the Rust engine runs (engine-rs runtime.rs PIECES). */
export const MODEL_PIECES = ["cradio", "moge", "rvm", "stage1", "stage2"] as const;

/**
 * The Rust engine: its program and the models folder (one <piece>_….onnx per network, or a models.json).
 * The engine itself checks the exact files and precision and says so in its pong ("assets").
 */
// loop: NOT-WORTH — a few stats + one readdir per Engine-page check (when the paths are set)
export function checkRustEngine(binary: string | null, models: string | null, exists: (p: string) => boolean = existsSync, list: (p: string) => string[] = (p) => readdirSync(p)): CheckoutCheck {
  const problems: string[] = [];
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

/** The engine the queue uses: the Rust engine when it is set up, else the PyTorch one, else none. */
export function chooseEngine(rust: CheckoutCheck, python: CheckoutCheck): EngineKind | null {
  if (rust.ok) return "rust";
  if (python.ok) return "python";
  return null;
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

/** The PyTorch engine runs from a CorridorKey2.0 checkout: its code, weights, foundation models and venv. */
export function checkCheckout(root: string | null, exists: (p: string) => boolean = existsSync): CheckoutCheck {
  if (!root) return { ok: false, problems: ["Choose your CorridorKey2.0 folder."] };
  const need: [string, string][] = [
    ["corridorkey/runtime.py", "the CorridorKey code"],
    ["venv/bin/python", "its Python environment (venv) — see the CorridorKey README, Setup"],
    ["weights/corridorkey_v2.safetensors", "the model weights — run scripts/download_weights.py"],
    ["vfms/cradio/C-RADIOv4-SO400M", "the C-RADIO foundation model — run scripts/download_weights.py"],
    ["vfms/moge/model.pt", "the MoGe foundation model — run scripts/download_weights.py"],
  ];
  // loop: NOT-WORTH — a few required paths, once per check
  const problems = need.filter(([p]) => !exists(join(root, p))).map(([p, what]) => `Missing ${p}: ${what}.`);
  return { ok: problems.length === 0, problems };
}
