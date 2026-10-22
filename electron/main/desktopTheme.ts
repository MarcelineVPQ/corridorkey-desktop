// Reads the desktop's colors for the Desktop theme and watches for changes so
// the open app follows along (the DS5 app's desktopTheme.ts).
//   KDE Plasma: the full color scheme from ~/.config/kdeglobals (else its accent).
//   Other Linux desktops: the accent from the XDG settings portal, if any.
//   Last: Electron's system accent (Windows, macOS, some Linux desktops).
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { nativeTheme, systemPreferences } from "electron";
import { kdeAccent, parseKdeGlobals, type DesktopPalette, type Rgb } from "../../src/ui/theme/palette";

const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const kdeGlobals = join(configDir, "kdeglobals");

/** KDE Plasma, also when started without XDG_CURRENT_DESKTOP (systemd-run, some launchers). */
export function isKdeSession(env: NodeJS.ProcessEnv, hasKdeGlobals: boolean, kdeRunning: () => boolean): boolean {
  if (/kde/i.test(env.XDG_CURRENT_DESKTOP ?? "")) return true;
  if (env.KDE_FULL_SESSION === "true") return true;
  if (/^(kde|plasma)/i.test(env.XDG_SESSION_DESKTOP ?? "") || /(^|\/)(kde|plasma)/i.test(env.DESKTOP_SESSION ?? "")) return true;
  return hasKdeGlobals && kdeRunning();
}

function plasmaRunning(): boolean {
  try {
    // loop: NOT-WORTH — one pass over the process list, once per app run (isKde caches it)
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        // loop: NOT-WORTH — one /proc read per process while scanning for Plasma, once per app start (the result is cached)
        if (/^(plasmashell|kwin_wayland|kwin_x11)$/.test(readFileSync(`/proc/${pid}/comm`, "utf8").trim())) return true;
      } catch {
        // error: NOT-WORTH — the process ended meanwhile: skip it
      }
    }
  } catch {
    // error: NOT-WORTH — no /proc: not KDE; the portal and the system accent are tried next
  }
  return false;
}

// cache: OK — key=none (the desktop session); invalidated=never, the session can't change under a running app; bound=1 entry
let kde: boolean | null = null;
function isKde(): boolean {
  if (process.platform !== "linux") return false;
  // loop: NOT-WORTH — one stat, once per app start (cached in `kde`)
  kde ??= isKdeSession(process.env, existsSync(kdeGlobals), plasmaRunning);
  // loop: NOT-WORTH — one stat per palette read (Desktop theme only, on a theme change)
  return kde && existsSync(kdeGlobals);
}

function hexAccent(hex: string): Rgb | null {
  const m = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

function systemAccent(): Rgb | null {
  try {
    return hexAccent(systemPreferences.getAccentColor() ?? "");
  } catch {
    // error: NOT-WORTH — not available here: null, and App settings says the desktop's colors couldn't be read
    return null;
  }
}

/** The XDG desktop portal's accent (GNOME 47+, others). */
function portalAccent(): Promise<Rgb | null> {
  return new Promise((resolve) => {
    // lifetime: OK — exits on its own; the 2 s timeout kills a hung gdbus
    // loop: NOT-WORTH — one gdbus portal read per palette refresh (Desktop theme only) [bounded: its 2 s timeout option]
    execFile(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.portal.Desktop",
        "--object-path",
        "/org/freedesktop/portal/desktop",
        "--method",
        "org.freedesktop.portal.Settings.ReadOne",
        "org.freedesktop.appearance",
        "accent-color",
      ],
      { timeout: 2000 },
      (error, stdout) => {
        // error: NOT-WORTH — no portal answers null: the system accent is tried next
        const m = !error && /\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/.exec(stdout);
        if (!m) return resolve(null);
        // loop: NOT-WORTH — three channels
        resolve([m[1], m[2], m[3]].map((v) => Math.round(Math.min(1, Math.max(0, Number(v))) * 255)) as Rgb);
      },
    );
  });
}

/** Null only when no accent can be read at all (App settings says so). */
export async function readDesktopPalette(): Promise<DesktopPalette | null> {
  const isDark = nativeTheme.shouldUseDarkColors;
  let text: string | null = null;
  if (isKde()) {
    try {
      // loop: NOT-WORTH — reads kdeglobals (a few KB) per palette refresh, Desktop theme only
      text = readFileSync(kdeGlobals, "utf8");
    } catch {
      // error: NOT-WORTH — no readable kdeglobals: the portal and the system accent are tried next
      text = null;
    }
  }
  if (text) {
    const full = parseKdeGlobals(text);
    if (full) return full;
    const accent = kdeAccent(text);
    if (accent) return { source: "accent", isDark, accent };
  }
  const accent = (process.platform === "linux" ? await portalAccent() : null) ?? systemAccent();
  return accent ? { source: "accent", isDark, accent } : null;
}

/** Calls `onChange` (debounced) whenever the desktop's colors may have changed. Returns stop. */
export function watchDesktopPalette(onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    // loop: NOT-WORTH — one-shot 300 ms debounce per settings-file change
    timer = setTimeout(onChange, 300); // lifetime: OK — one-shot 300 ms debounce, cleared by the next fire()
  };
  let watcher: FSWatcher | null = null;
  if (isKde()) {
    // KDE rewrites kdeglobals atomically (new file + rename), so watch the folder.
    try {
      // lifetime: OK — closed by the returned stop at quit
      watcher = watch(configDir, (_event, file) => {
        if (file === "kdeglobals") fire();
      });
    } catch {
      // error: NOT-WORTH — no config folder to watch: a change is picked up at the next start
      watcher = null;
    }
  }
  nativeTheme.on("updated", fire); // lifetime: OK — removed by the returned stop
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
    nativeTheme.removeListener("updated", fire);
  };
}
