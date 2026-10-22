// Settings file (userData/settings.json) and the CorridorKey checkout check.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_APPEARANCE, DEFAULT_OPTIONS, type CheckoutCheck, type EngineKind, type Settings } from "../../src/shared/types";

export function loadSettings(file: string, env: NodeJS.ProcessEnv): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Settings>;
  } catch {
    // error: NOT-WORTH — no file yet (first start) or unreadable: start from the defaults
  }
  return {
    corridorKeyRoot: env.CK_PACKAGE_ROOT || saved.corridorKeyRoot || null,
    lastOptions: { ...DEFAULT_OPTIONS, ...(saved.lastOptions ?? {}) },
    appearance: { ...DEFAULT_APPEARANCE, ...(saved.appearance ?? {}) },
    outputRoot: saved.outputRoot ?? null,
    engineBinary: env.CK_ENGINE_BIN || saved.engineBinary || null,
    modelsDir: env.CK_ENGINE_MODELS || saved.modelsDir || null,
    ortLibrary: env.CK_ENGINE_ORT || saved.ortLibrary || null,
  };
}

/** The five networks the Rust engine runs (engine-rs runtime.rs PIECES). */
export const MODEL_PIECES = ["cradio", "moge", "rvm", "stage1", "stage2"] as const;

/**
 * The Rust engine: its program and the models folder (one <piece>_….onnx per network, or a models.json).
 * The engine itself checks the exact files and precision and says so in its pong ("assets").
 */
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
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2));
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
  const problems = need.filter(([p]) => !exists(join(root, p))).map(([p, what]) => `Missing ${p}: ${what}.`);
  return { ok: problems.length === 0, problems };
}
