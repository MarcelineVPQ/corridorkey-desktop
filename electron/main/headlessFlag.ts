// `corridorkey run FILE.ckcmd` starts the app's own executable with HEADLESS_FLAG (review 2026-10-28 #3: it used to start
// it as Node, ELECTRON_RUN_AS_NODE, which kept the runAsNode fuse on: any local process could run its own JavaScript as
// the signed app, with its macOS privacy grants). The flag runs one fixed script runner (console/headless.ts) bundled in
// the app, never a script named on the command line; the command line is checked here word for word, and a packaged
// app takes only its own command-line program as the one the script's commands run. Pure: boot.ts and the tests use it.
import { posix, win32 } from "node:path";
import { headlessArgs } from "./console/headless";

export const HEADLESS_FLAG = "--ck-headless";

/** Chromium switches ck-cli (headless.rs) may put before the flag: a runner with no window, no GPU, no web content. */
export const HEADLESS_SWITCHES: readonly string[] = ["--no-sandbox", "--ozone-platform=headless", "--password-store=basic", "--disable-gpu", "--log-level=3"];

export type HeadlessLaunch = { argv: string[]; cli: string } | { error: string } | null;

/**
 * What a start with HEADLESS_FLAG asks for: `[app] [switches…] --ck-headless run [--keep-going] FILE`, nothing else
 * (null: no flag, the app's window starts). `defaultApp`: a development Electron, whose argv[1] is the app's folder.
 * `bundledCli`: a packaged app's own command-line program, the only one it runs (null: a development build, any);
 * `cliEnv` and it as real paths (boot.ts), compared without case on Windows. `parentPid`: the process that started this
 * one; on macOS launchd's (1) means LaunchServices or launchd started it (`open -a`, a LaunchAgent), which is refused: the
 * script's reads would run as CorridorKey with its privacy grants, not as the caller (re-review 2026-10-28 S1). ck-cli
 * execs the app, so its parent is the caller's shell, cron or farm process.
 */
export function headlessLaunch(argv: readonly string[], defaultApp: boolean, cliEnv: string | undefined, bundledCli: string | null, platform: NodeJS.Platform, parentPid: number): HeadlessLaunch {
  if (!argv.includes(HEADLESS_FLAG)) return null;
  if (platform === "darwin" && parentPid === 1) return { error: "started by launchd or LaunchServices: start corridorkey run from a shell (a LaunchAgent: /bin/sh -c '… ; exit $?')" };
  const at = argv.indexOf(HEADLESS_FLAG);
  const before = argv.slice(defaultApp ? 2 : 1, at);
  // loop: NOT-WORTH — a few switches, once at start
  if (at < (defaultApp ? 2 : 1) || !before.every((a) => HEADLESS_SWITCHES.includes(a))) return { error: `${HEADLESS_FLAG} is for corridorkey run only` };
  const rest = argv.slice(at + 1);
  const args = headlessArgs(rest);
  if ("error" in args) return args;
  // a file that reads as a switch: Chromium would take it as one
  if (args.file.startsWith("-")) return { error: `the script's name starts with "-": name it ./${args.file}` };
  const path = platform === "win32" ? win32 : posix;
  if (!cliEnv || !path.isAbsolute(cliEnv)) return { error: "start it as corridorkey run (the command line passes itself to it)" };
  const same = (a: string, b: string) => (platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
  if (bundledCli !== null && !same(cliEnv, bundledCli)) return { error: `the command line isn't this app's own (${bundledCli})` };
  return { argv: rest, cli: cliEnv };
}

/** A packaged app's command-line program: `resources/engine/corridorkey` (Windows `corridorkey.exe`), as engineFind.ts findCli. */
export function bundledCliPath(resourcesPath: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? win32.join(resourcesPath, "engine", "corridorkey.exe") : posix.join(resourcesPath, "engine", "corridorkey");
}

/** The prefix of a headless run's own Chromium folder in the temp folder (boot.ts). */
export const HEADLESS_SESSION_PREFIX = "ck-headless-";

/**
 * Headless session folders a day old or more (`mtimeMs`: null when one can't be read): on Windows a run leaves its
 * folder when Chromium still holds it at exit (boot.ts lets the exit go first), so the next run sweeps them. A day:
 * never a run still going, which keeps writing into its own.
 */
export function staleHeadlessSessions(names: string[], mtimeMs: (name: string) => number | null, now: number): string[] {
  // loop: NOT-WORTH — the temp folder's entries, once per headless start
  return names.filter((n) => {
    if (!n.startsWith(HEADLESS_SESSION_PREFIX)) return false;
    const t = mtimeMs(n);
    return t !== null && now - t >= 24 * 3600 * 1000;
  });
}
