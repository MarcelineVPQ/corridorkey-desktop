// The app's entry (package.json "main"): the window (index.ts), or, started with --ck-headless by `corridorkey run`,
// the Console's script runner with no window (console/headless.ts; review 2026-10-28 #3: this flag replaced starting
// the app as Node, so the runAsNode fuse is off). Decided before anything of the window's starts: no single-instance
// lock, no settings migration, no IPC. The page can't reach this: it is the process's own command line.
import { app } from "electron";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledCliPath, headlessLaunch } from "./headlessFlag";
import { PLATFORM } from "./platform";

/** A path with its links resolved (a CLI started through a link on PATH), else as it is. */
const real = (p: string) => {
  try {
    // loop: NOT-WORTH — one sync call at start, only with --ck-headless
    return realpathSync(p);
  } catch {
    // error: NOT-WORTH — compared as given; a path that isn't there doesn't match the app's own
    return p;
  }
};
const cliEnv = process.env.CK_HEADLESS_CLI;
const bundledCli = app.isPackaged ? real(bundledCliPath(process.resourcesPath, PLATFORM)) : null;
// loop: NOT-WORTH — a few words of argv, once at start
const launch = process.argv.includes("--ck-headless") ? headlessLaunch(process.argv, !!process.defaultApp, cliEnv && real(cliEnv), bundledCli, PLATFORM, process.ppid) : null;

// awaited at the top level: Electron waits for it before "ready", so index.ts's before-ready calls (its command-line
// switches, registerSchemesAsPrivileged for ck-media) run in time (re-review 2026-10-28 M1)
if (launch === null) await import("./index");
else {
  // no Dock icon, no graphics card (rule 11), and Chromium's own files in a folder of its own, not the window's
  app.dock?.hide();
  app.disableHardwareAcceleration();
  // loop: NOT-WORTH — one local mkdir at start, before anything else runs
  const session = mkdtempSync(join(tmpdir(), "ck-headless-"));
  app.setPath("sessionData", session);
  const end = (code: number) => {
    try {
      // loop: NOT-WORTH — Chromium's few files of one script run, once at exit (no window waits)
      rmSync(session, { recursive: true, force: true });
    } catch {
      // error: NOT-WORTH — Windows: Chromium still holds files in it (ENOTEMPTY); the throw skipped app.exit and the run
      // never ended (Windows VM, dev.2 release check 2026-10-28). The folder stays in the temp folder; the exit comes first
    }
    app.exit(code);
  };
  // loop: NOT-WORTH — one script per process
  void import("./console/headless").then(async (h) => {
    if ("error" in launch) return end(h.refuseHeadless(launch.error));
    await app.whenReady();
    return h.runHeadless(launch.argv, launch.cli, { name: app.getName(), version: app.getVersion() }).then(end, (e: unknown) => {
      // error: SHOWN — said on stderr, exit 8 (the CLI's "the engine failed: a bug")
      process.stderr.write(`corridorkey run: stopped: ${String((e as Error)?.message ?? e)}\n`);
      end(8);
    });
  });
}
