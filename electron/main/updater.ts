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
import { fallbackShell, relaunchArgs, relaunchEnv, shellArgs, systemdRunArgs } from "./relaunch";
import { feedSource } from "./updateFeed";
import { UpdateFlow, type FileOps, type UpdatePlatform } from "./updateFlow";

const FEED_TIMEOUT_MS = 15_000;

// Why this copy can't replace itself, or null.
function unsupportedReason(keys: readonly string[]): string | null {
  if (process.platform === "win32") return "On Windows, new versions are on GitHub: github.com/MarcelineVPQ/corridorkey-desktop/releases (self-update is Linux only for now).";
  if (process.platform === "darwin") return "On macOS, new versions are on GitHub: github.com/MarcelineVPQ/corridorkey-desktop/releases (self-update is Linux only for now).";
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
    // loop: NOT-WORTH — one realpath, once per start (the running AppImage)
    return realpathSync(raw);
  } catch {
    // error: NOT-WORTH — unresolvable: the APPIMAGE path as given is used
    return raw;
  }
}

const fileOps: FileOps = {
  // loop: NOT-WORTH — the update folder's few files, once per update action
  readdir: (dir) => readdirSync(dir),
  // loop: NOT-WORTH — one unlink per stale AppImage, once per update action
  rm: (path) => rmSync(path, { force: true }),
  // loop: NOT-WORTH — one chmod per downloaded AppImage
  chmod: (path, mode) => chmodSync(path, mode),
  // loop: NOT-WORTH — one rename per downloaded AppImage
  rename: (from, to) => renameSync(from, to),
  // loop: NOT-WORTH — one stat per update step
  exists: (path) => existsSync(path),
  kind: (path) => {
    // loop: NOT-WORTH — one lstat per update step
    const st = lstatSync(path, { throwIfNoEntry: false });
    return !st ? null : st.isSymbolicLink() ? "link" : "file";
  },
  // loop: NOT-WORTH — one symlink per install
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
  // The mount guard first: it waits for this copy's processes as they are now. Started after the new copy, it
  // counted the fallback shell (which becomes the new copy) as ours and held the old mount, and every descriptor
  // it inherited (the DevTools port in tools/update_e2e.sh), for its whole 5 s.
  holdAppImageMountUntilExit();
  const shell = fallbackShell(existsSync);
  let started = false;
  // loop: SERIAL-REQUIRED — retry: the second form only when systemd refused the first (2 tries)
  for (const exitTypeCgroup of [true, false]) {
    try {
      // At most 5 s: systemd-run blocks the main process while it waits, and on a
      // session bus without systemd it waits for D-Bus's own 25 s timeout
      // (found by tools/update_e2e.sh: the restart froze the window).
      // loop: SERIAL-REQUIRED — systemd-run for the relaunch, 5 s timeout, at most two tries (with and without ExitType=cgroup), once per restart
      execFileSync("systemd-run", systemdRunArgs({ target, args, env, unit, exitTypeCgroup, oldPid: process.pid, shell }), { stdio: "ignore", timeout: 5000 });
      started = true;
      break;
    } catch {
      // error: NOT-WORTH — systemd-run unavailable or too old for the property: the next form, then the shell below
    }
  }
  if (!started) {
    try {
      // lifetime: OK — detached and unref'd: the new copy outlives this one on purpose (app.quit next)
      spawn(shell, shellArgs(process.pid, target, args), { detached: true, stdio: "ignore", env }).unref();
    } catch (e) {
      // error: LOGGED-OK — the app quits either way; the next start from the menu runs the new version
      console.error("[updater] could not start the new copy:", e);
    }
  }
  app.quit();
  // lifetime: OK — fires once; the process is gone before it unless the quit was held up
  // loop: SERIAL-REQUIRED — the exit fallback 10 s after a relaunch was handed off, once
  setTimeout(() => app.exit(0), 10_000).unref();
}

function platform(version: string): UpdatePlatform {
  const source = feedSource(process.env);
  // loop: NOT-WORTH — the fetch the feed reader is given; every caller passes an AbortSignal.timeout [bounded: FEED_TIMEOUT_MS at the call site]
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
      // loop: NOT-WORTH — one feed read per update check, FEED_TIMEOUT_MS
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
