// ffmpeg / ffprobe: the app and the engine read and write video with the system's copies (not bundled,
// Marcy 2026-10-24: detect it and offer to install it). The check runs both and asks ffmpeg for the two
// encoders the engine writes with (libx264 for the comp, prores_ks for the 4444 alpha), since a distro's
// patent-free build can lack libx264. The install runs the distro's package manager through pkexec (the
// desktop's own password prompt); where the stock package lacks libx264 (Fedora, openSUSE) the app shows
// what to enable instead of installing a build that can't write the results.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { FfmpegState } from "../../src/shared/types";

export type RunFn = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;

const CHECK_TIMEOUT_MS = 15_000;
export const INSTALL_TIMEOUT_MS = 15 * 60_000;

export const runFile: RunFn = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    // loop: SERIAL-REQUIRED — one ffmpeg/ffprobe check or one install at a time, with its own timeout
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

export interface InstallPlan {
  // what the user reads (and can copy), e.g. "sudo apt install ffmpeg"
  command: string;
  // what the app runs through pkexec; null = the app can't install a usable ffmpeg here, `note` says what to do
  argv: string[] | null;
  note: string | null;
}

/** The install for this distro, from /etc/os-release's ID and ID_LIKE. */
export function installPlan(osRelease: string): InstallPlan {
  const field = (k: string) => (osRelease.match(new RegExp(`^${k}="?([^"\\n]*)"?$`, "m"))?.[1] ?? "").toLowerCase();
  // loop: NOT-WORTH — a few words from os-release
  const ids = [field("ID"), ...field("ID_LIKE").split(/\s+/)].filter(Boolean);
  // loop: NOT-WORTH — a few os-release ids
  if (ids.some((i) => i === "debian" || i === "ubuntu")) return { command: "sudo apt install ffmpeg", argv: ["apt-get", "install", "-y", "ffmpeg"], note: null };
  // loop: NOT-WORTH — a few os-release ids
  if (ids.some((i) => i === "arch")) return { command: "sudo pacman -S ffmpeg", argv: ["pacman", "-S", "--noconfirm", "--needed", "ffmpeg"], note: null };
  // loop: NOT-WORTH — a few os-release ids
  if (ids.some((i) => i === "fedora" || i === "rhel"))
    return {
      command: "sudo dnf install ffmpeg --allowerasing",
      argv: null,
      note: "Fedora's own ffmpeg can't write H.264. Enable RPM Fusion (rpmfusion.org/Configuration), then run this command.",
    };
  // loop: NOT-WORTH — a few os-release ids
  if (ids.some((i) => i.startsWith("opensuse") || i === "suse"))
    return { command: "sudo zypper install ffmpeg", argv: null, note: "openSUSE's own ffmpeg can't write H.264. Add the Packman repository first, then run this command." };
  return { command: "Install ffmpeg with your distribution's package manager", argv: null, note: null };
}

/** Is a usable ffmpeg there: both programs, and the encoders the engine writes with. */
export async function checkFfmpeg(run: RunFn = runFile): Promise<{ ok: boolean; problem: string | null }> {
  try {
    // loop: SERIAL-REQUIRED — one check at a time [bounded: CHECK_TIMEOUT_MS]
    await run("ffprobe", ["-version"], CHECK_TIMEOUT_MS);
  } catch {
    // error: SHOWN — the Engine page's ffmpeg section and its task say so
    return { ok: false, problem: "ffmpeg isn't installed (ffprobe not found)" };
  }
  let encoders: string;
  try {
    // loop: SERIAL-REQUIRED — one check at a time [bounded: CHECK_TIMEOUT_MS]
    encoders = await run("ffmpeg", ["-hide_banner", "-encoders"], CHECK_TIMEOUT_MS);
  } catch {
    // error: SHOWN — as above
    return { ok: false, problem: "ffmpeg isn't installed" };
  }
  // loop: NOT-WORTH — two encoder names
  const missing = ["libx264", "prores_ks"].filter((e) => !new RegExp(`\\s${e}\\s`).test(encoders));
  if (missing.length) return { ok: false, problem: `This ffmpeg can't write ${missing.join(" or ")} (a build without it)` };
  return { ok: true, problem: null };
}

/** The state the Engine page shows, before any install is tried. */
export function ffmpegState(check: { ok: boolean; problem: string | null }, plan: InstallPlan): FfmpegState {
  return { ok: check.ok, problem: check.problem, command: plan.command, canInstall: plan.argv !== null, note: plan.note, installing: false, installError: null };
}

export function readOsRelease(): string {
  try {
    // loop: NOT-WORTH — reads /etc/os-release (a few hundred bytes) once per check
    return readFileSync("/etc/os-release", "utf8");
  } catch {
    // error: NOT-WORTH — no os-release: the generic "use your package manager" advice
    return "";
  }
}

/** Run the install through pkexec (the desktop asks for the password). Rejects with a readable reason. */
export async function installFfmpeg(plan: InstallPlan, run: RunFn = runFile): Promise<void> {
  if (!plan.argv) throw new Error("the app can't install ffmpeg on this system");
  try {
    // loop: SERIAL-REQUIRED — one install at a time [bounded: INSTALL_TIMEOUT_MS]
    await run("pkexec", plan.argv, INSTALL_TIMEOUT_MS);
  } catch (e) {
    // error: PASSES-ON — the Engine page shows it next to the command to run by hand
    const code = (e as { code?: unknown }).code;
    if (code === "ENOENT") throw new Error(`pkexec isn't available: run "${plan.command}" in a terminal`);
    if (code === 126) throw new Error("the password prompt was cancelled");
    throw new Error(`the install failed: run "${plan.command}" in a terminal to see why`);
  }
}
