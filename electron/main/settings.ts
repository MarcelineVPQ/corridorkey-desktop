// Settings file (userData/settings.json) and the CorridorKey checkout check.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_OPTIONS, type CheckoutCheck, type Settings } from "../../src/shared/types";

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
  };
}

/** Write atomically (temp file + rename) so a crash never leaves half a file. */
export function saveSettings(file: string, settings: Settings): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2));
  renameSync(tmp, file);
}

/** The engine runs from a CorridorKey2.0 checkout: its code, weights, foundation models and venv. */
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
