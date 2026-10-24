// ffmpeg / ffprobe: the app and the engine read and write video with the system's copies (not bundled,
// Marcy 2026-10-24: detect it and offer to install it). The check runs both and asks ffmpeg for the two
// encoders the engine writes with (libx264 for the comp, prores_ks for the 4444 alpha), since a distro's
// patent-free build can lack libx264. The install runs the distro's package manager through pkexec (the
// desktop's own password prompt); where the stock package lacks libx264 (Fedora, openSUSE) the app shows
// what to enable instead of installing a build that can't write the results.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FfmpegState } from "../../src/shared/types";

export type RunFn = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;

const CHECK_TIMEOUT_MS = 15_000;
// no deadline for the install: a timeout would kill apt / pacman halfway and could leave the package database locked
export const INSTALL_TIMEOUT_MS = 0;

export const runFile: RunFn = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    // loop: SERIAL-REQUIRED — one ffmpeg/ffprobe check or one install at a time, with its own timeout
    // a failure carries the program's output, so the app can show its last line
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 << 20, windowsHide: true }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve(stdout)));
  });

export interface InstallPlan {
  // what the user reads (and can copy), e.g. "sudo apt install ffmpeg"
  command: string;
  // what the app runs (through pkexec when `elevate`); null = the app can't install a usable ffmpeg here, `note` says what to do
  argv: string[] | null;
  elevate?: boolean;
  note: string | null;
}

/** Windows: winget's full ffmpeg build (it has libx264); winget asks for permission itself, no pkexec. */
export const WINDOWS_PLAN: InstallPlan = {
  command: "winget install --id Gyan.FFmpeg -e",
  argv: ["winget", "install", "--id", "Gyan.FFmpeg", "-e", "--accept-source-agreements", "--accept-package-agreements"],
  elevate: false,
  note: null,
};

/** The install for this system: Windows, or the Linux distro from /etc/os-release's ID and ID_LIKE. */
export function planFor(platform: NodeJS.Platform, osRelease: string): InstallPlan {
  return platform === "win32" ? WINDOWS_PLAN : installPlan(osRelease);
}

/** The install for this distro, from /etc/os-release's ID and ID_LIKE. */
export function installPlan(osRelease: string): InstallPlan {
  // os-release values may be bare, "double" or 'single' quoted
  const field = (k: string) => (osRelease.match(new RegExp(`^${k}=["']?([^"'\\n]*)["']?$`, "m"))?.[1] ?? "").toLowerCase();
  // loop: NOT-WORTH — a few words from os-release
  const ids = [field("ID"), ...field("ID_LIKE").split(/\s+/)].filter(Boolean);
  // read-only (image-based) systems: the family's package manager can't install there (SteamOS is ID_LIKE=arch,
  // Bazzite / Silverblue / Kinoite are ID=fedora with rpm-ostree)
  const immutable = ["steamos", "bazzite", "bluefin", "aurora"].includes(field("ID")) || /silverblue|kinoite|sericea|onyx|atomic/.test(field("VARIANT_ID"));
  if (immutable)
    return {
      command: "Install ffmpeg the way your system recommends",
      argv: null,
      note: "This system's base is read-only, so the app can't install ffmpeg with the package manager. Your distribution's documentation says how to add it.",
    };
  // loop: NOT-WORTH — a few os-release ids
  // the package lists first: on a system that hasn't updated in a while, install alone fails with 404s
  if (ids.some((i) => i === "debian" || i === "ubuntu"))
    return { command: "sudo apt update && sudo apt install ffmpeg", argv: ["sh", "-c", "apt-get update && apt-get install -y ffmpeg"], note: null };
  // loop: NOT-WORTH — a few os-release ids
  if (ids.some((i) => i === "arch")) return { command: "sudo pacman -S ffmpeg", argv: ["pacman", "-S", "--noconfirm", "--needed", "ffmpeg"], note: null };
  // loop: NOT-WORTH — a few os-release ids
  if (ids.some((i) => i === "rhel"))
    return {
      command: "sudo dnf install ffmpeg",
      argv: null,
      note: "Rocky, Alma and other RHEL-family systems have no ffmpeg of their own. Enable EPEL and RPM Fusion (rpmfusion.org/Configuration), then run this command.",
    };
  // loop: NOT-WORTH — a few os-release ids
  if (ids.some((i) => i === "fedora"))
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

const notFound = (e: unknown) => (e as { code?: unknown }).code === "ENOENT";

/** Is a usable ffmpeg there: both programs, and the encoders the engine writes with. */
export async function checkFfmpeg(run: RunFn = runFile): Promise<{ ok: boolean; problem: string | null }> {
  try {
    // loop: SERIAL-REQUIRED — one check at a time [bounded: CHECK_TIMEOUT_MS]
    await run("ffprobe", ["-version"], CHECK_TIMEOUT_MS);
  } catch (e) {
    // error: SHOWN — the Engine page's ffmpeg section and its task say so
    return { ok: false, problem: notFound(e) ? "ffmpeg isn't installed (ffprobe not found)" : `ffprobe didn't answer (${(e as Error).message})` };
  }
  let encoders: string;
  try {
    // loop: SERIAL-REQUIRED — one check at a time [bounded: CHECK_TIMEOUT_MS]
    encoders = await run("ffmpeg", ["-hide_banner", "-encoders"], CHECK_TIMEOUT_MS);
  } catch (e) {
    // error: SHOWN — as above
    return { ok: false, problem: notFound(e) ? "ffmpeg isn't installed (ffprobe is, ffmpeg isn't)" : `ffmpeg didn't answer (${(e as Error).message})` };
  }
  // loop: NOT-WORTH — two encoder names
  const missing = ["libx264", "prores_ks"].filter((e) => !new RegExp(`\\s${e}\\s`).test(encoders));
  if (missing.length) return { ok: false, problem: `This ffmpeg can't write ${missing.join(" or ")} (a build without it)` };
  return { ok: true, problem: null };
}

/** The state the Engine page shows, before any install is tried. */
export function ffmpegState(check: { ok: boolean; problem: string | null }, plan: InstallPlan): FfmpegState {
  return {
    checked: true,
    ok: check.ok,
    problem: check.problem,
    command: plan.command,
    canInstall: plan.argv !== null,
    asksPassword: plan.elevate !== false,
    note: plan.note,
    installing: false,
    installError: null,
  };
}

/**
 * Windows: where winget puts ffmpeg. Its Links folder when it can make links; else the package's own bin folder,
 * which it adds to the user's PATH, but a program already running never sees a PATH change, so the app looks there.
 */
// loop: NOT-WORTH — a few readdirs of winget's folders, once per ffmpeg check on Windows
export function wingetFfmpegDirs(localAppData: string, list: (p: string) => string[] = (p) => readdirSync(p)): string[] {
  const root = join(localAppData, "Microsoft", "WinGet");
  const out = [join(root, "Links")];
  const ls = (p: string) => {
    try {
      return list(p);
    } catch {
      // error: NOT-WORTH — no such folder (winget never installed ffmpeg): nothing to add
      return [];
    }
  };
  // loop: NOT-WORTH — winget's package folders (a few), once per ffmpeg check on Windows
  for (const pkg of ls(join(root, "Packages")).filter((n) => n.startsWith("Gyan.FFmpeg")))
    // loop: NOT-WORTH — the one ffmpeg-<version> folder inside
    for (const sub of ls(join(root, "Packages", pkg))) if (ls(join(root, "Packages", pkg, sub)).includes("bin")) out.push(join(root, "Packages", pkg, sub, "bin"));
  return out;
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
    // loop: SERIAL-REQUIRED — one install at a time [bounded: the user's password prompt and the package manager; never killed mid-install]
    await (plan.elevate === false ? run(plan.argv[0], plan.argv.slice(1), INSTALL_TIMEOUT_MS) : run("pkexec", plan.argv, INSTALL_TIMEOUT_MS));
  } catch (e) {
    // error: PASSES-ON — the Engine page shows it next to the command to run by hand
    const code = (e as { code?: unknown }).code;
    if (code === "ENOENT") throw new Error(`${plan.elevate === false ? plan.argv[0] : "pkexec"} isn't available: run "${plan.command}" in a terminal`);
    if (code === 126) throw new Error("the password prompt was cancelled");
    // the package manager's own last line says why (e.g. no network, a source error)
    // loop: NOT-WORTH — the failed install's output lines, once per failure
    const said = `${(e as { stderr?: string }).stderr ?? ""}\n${(e as { stdout?: string }).stdout ?? ""}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    throw new Error(`the install failed${said ? ` (${said.slice(0, 200)})` : ""}: run "${plan.command}" in a terminal to see more`);
  }
}
