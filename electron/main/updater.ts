// The app's self-updater: updateFlow.ts (the rules, tested without Electron)
// bound to Electron's network, files and quit. The main process owns one
// Updater, shows its `state`, and gates restart() while the queue runs.
// docs/RELEASING.md says how releases and the signed feeds are made.
import { app, net } from "electron";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { holdAppImageMountUntilExit } from "./appImageQuit";
import type { FetchFn } from "./download";
import { relaunchArgs, relaunchEnv, shellArgs, systemdRunArgs } from "./relaunch";
import { feedSource } from "./updateFeed";
import { UpdateFlow, type FileOps, type UpdatePlatform } from "./updateFlow";

const FEED_TIMEOUT_MS = 15_000;

// Why this copy can't replace itself, or null.
function unsupportedReason(keys: readonly string[]): string | null {
  if (process.platform !== "linux") return "Updates are built for the Linux AppImage only.";
  if (!app.isPackaged) return "Updates come with the AppImage build; this copy runs from source.";
  if (!process.env.APPIMAGE) return "Updates work only in the AppImage build; this copy isn't running as an AppImage.";
  if (!keys.length) return "No release channel is set up in this build.";
  return null;
}

function runningAppImage(): string | null {
  const raw = process.env.APPIMAGE;
  if (!raw) return null;
  try {
    return realpathSync(raw);
  } catch {
    // error: NOT-WORTH — unresolvable: the APPIMAGE path as given is used
    return raw;
  }
}

const fileOps: FileOps = {
  readdir: (dir) => readdirSync(dir),
  rm: (path) => rmSync(path, { force: true }),
  chmod: (path, mode) => chmodSync(path, mode),
  rename: (from, to) => renameSync(from, to),
  exists: (path) => existsSync(path),
  kind: (path) => {
    const st = lstatSync(path, { throwIfNoEntry: false });
    return !st ? null : st.isSymbolicLink() ? "link" : "file";
  },
  symlink: (target, path) => symlinkSync(target, path),
};

// Start `target` in a clean session environment through the user's systemd
// (Sonata's relaunch: outside this AppImage's mount and process tree), then
// quit normally so before-quit stops the engine and will-quit runs.
function relaunch(target: string): void {
  app.releaseSingleInstanceLock();
  const env = relaunchEnv(process.env);
  const args = relaunchArgs(process.argv);
  const unit = `corridorkey-relaunch-${Date.now()}`;
  let started = false;
  // loop: SERIAL-REQUIRED — retry: the second form only when systemd refused the first (2 tries)
  for (const exitTypeCgroup of [true, false]) {
    try {
      // At most 5 s: systemd-run blocks the main process while it waits, and on a
      // session bus without systemd it waits for D-Bus's own 25 s timeout
      // (found by tools/update_e2e.sh: the restart froze the window).
      execFileSync("systemd-run", systemdRunArgs({ target, args, env, unit, exitTypeCgroup }), { stdio: "ignore", timeout: 5000 });
      started = true;
      break;
    } catch {
      // error: NOT-WORTH — systemd-run unavailable or too old for the property: the next form, then the shell below
    }
  }
  if (!started) {
    try {
      // lifetime: OK — detached and unref'd: the new copy outlives this one on purpose (app.quit next)
      spawn("/bin/sh", shellArgs(target, args), { detached: true, stdio: "ignore", env }).unref();
    } catch (e) {
      // error: LOGGED-OK — the app quits either way; the next start from the menu runs the new version
      console.error("[updater] could not start the new copy:", e);
    }
  }
  holdAppImageMountUntilExit();
  app.quit();
  // lifetime: OK — fires once; the process is gone before it unless the quit was held up
  setTimeout(() => app.exit(0), 10_000).unref();
}

function platform(version: string): UpdatePlatform {
  const source = feedSource(process.env);
  const fetchFn: FetchFn = (url, init) => net.fetch(url, init);
  return {
    version,
    source,
    appImage: runningAppImage(),
    unsupported: unsupportedReason(source.keys),
    prefsFile: join(app.getPath("userData"), "updates.json"),
    fetchText: async (url, fresh) => {
      // no-cache: never Chromium's own cached copy of a feed
      const headers: Record<string, string> = fresh ? { Accept: "application/vnd.github.raw", "Cache-Control": "no-cache" } : { "Cache-Control": "no-cache" };
      const r = await net.fetch(url, { headers, signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
      return { status: r.status, text: r.ok ? await r.text() : "" };
    },
    fetch: fetchFn,
    fs: fileOps,
    relaunch,
    now: () => Date.now(),
    log: (m) => console.log(`[updater] ${m}`),
  };
}

export class Updater extends UpdateFlow {
  constructor(deps: { changed: () => void; version: string }) {
    super(platform(deps.version), deps.changed);
  }
}
