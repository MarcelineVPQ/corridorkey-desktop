// `corridorkey run nightly.ckcmd` (SME review 2026-10-27 N12, backlog row 151): a Console script without the app's
// window, from cron or as a farm's pre-job. ck-cli's `run` starts the app's own executable as Node
// (ELECTRON_RUN_AS_NODE) on this file, so the script goes through the same parser, registry, checks and runner as the
// Console's `run`: never a system shell, writes only into the folders the app's settings allow, the same audit log.
// What a window would ask has no one to answer here, so it is refused, in words: a line that replaces files (sudo),
// `allow`. The blocks print as they go (output on stdout, errors on stderr); the exit status is the script's.
//
// lifetime: one process per `corridorkey run`, ended by the script's end (SIGINT / SIGTERM stop it as Ctrl+C does; on
// Windows, where Electron's run-as-node never calls them, ck-cli's `stop` line on stdin does: CK_HEADLESS_STOP=stdin).
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appDirs, PLATFORM } from "../platform";
import { cacheDirFor } from "../cacheFolder";
import { loadSettings } from "../settings";
import { makeRegistry } from "../../../src/shared/console/registry";
import { quoteArg } from "../../../src/shared/console/parse";
import type { ConsoleBlock } from "../../../src/shared/types";
import { blockTable } from "../../../src/ui/console/model";
import { Console, statusOf } from "./runner";
import { Elevation } from "./elevation";
import { AuditLog, History } from "./logs";
import { consoleFs } from "./files";
import { realPathDeps } from "./paths";

/** Electron's userData folder for an app named `name` (app.getPath("userData")): where the settings and logs are. */
export function userDataDir(name: string, env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), name);
  if (platform === "darwin") return join(home, "Library", "Application Support", name);
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), name);
}

/** `run [--keep-going] FILE`, as ck-cli passes it; else what is wrong. */
export function headlessArgs(argv: readonly string[]): { file: string; keepGoing: boolean } | { error: string } {
  if (argv[0] !== "run") return { error: "usage: corridorkey run [--keep-going] FILE.ckcmd" };
  // loop: NOT-WORTH — two or three words
  const rest = argv.slice(1).filter((a) => a !== "--keep-going");
  if (rest.length !== 1) return { error: "usage: corridorkey run [--keep-going] FILE.ckcmd" };
  return { file: rest[0], keepGoing: rest.length < argv.length - 1 };
}

/**
 * What the blocks print, line by line, as they go: each block's new lines once (its notes and output on stdout, its
 * errors on stderr), a listing or doctor's table when the block ends, a render's progress every 10 %.
 */
export class Printer {
  private readonly printed = new Map<number, { lines: number; tenth: number; ended: boolean }>();
  constructor(private readonly write: (stream: "out" | "err", text: string) => void) {}

  block(b: ConsoleBlock): void {
    const seen = this.printed.get(b.id) ?? { lines: 0, tenth: -1, ended: false };
    // the lines not printed yet (dropped ones, CONSOLE_LINES_KEPT, are gone)
    const from = Math.max(0, seen.lines - b.linesDropped);
    // loop: NOT-WORTH — a block's new lines (≤ CONSOLE_LINES_KEPT)
    for (const l of b.lines.slice(from)) this.write(l.kind === "err" ? "err" : "out", l.text);
    seen.lines = b.linesDropped + b.lines.length;
    const tenth = b.progress ? Math.floor(b.progress.percent / 10) : -1;
    if (b.progress && tenth > seen.tenth) this.write("out", `${b.line}: ${b.progress.done}/${b.progress.total} frames`);
    seen.tenth = Math.max(seen.tenth, tenth);
    if (b.state !== "running" && !seen.ended) {
      seen.ended = true;
      // loop: NOT-WORTH — a listing's rows, once
      for (const l of blockTable(b)) this.write("out", l);
      if (b.state !== "done") this.write("err", `${b.line.split("\n")[0]}: ${b.state}${b.exitCode !== null ? ` (exit ${b.exitCode})` : ""}`);
    }
    this.printed.set(b.id, seen);
  }
}

/** The line ck-cli writes on the runner's stdin for Ctrl+C / Ctrl+Break on Windows (ck-cli headless.rs STOP_LINE). */
export const STOP_LINE = "stop";

/** Calls `stop` for each `stop` line read from `input` (ck-cli's Ctrl+C on Windows); any other line is ignored. */
export function onStopLines(input: NodeJS.ReadableStream, stop: () => void): void {
  // lifetime: OK — reads until ck-cli's end of the pipe closes; the process ends with the script
  createInterface({ input, terminal: false }).on("line", (l) => {
    if (l.trim() === STOP_LINE) stop();
  });
}

const say = (text: string) => process.stderr.write(`corridorkey run: ${text}\n`);

async function main(argv: string[]): Promise<number> {
  const args = headlessArgs(argv);
  if ("error" in args) {
    say(args.error);
    return 2;
  }
  const cli = process.env.CK_HEADLESS_CLI;
  if (!cli) {
    say("start it as corridorkey run (the command line passes itself to it)");
    return 2;
  }
  // the app's name as Electron reads it from its package.json (its productName, else its name): its userData folder
  // loop: NOT-WORTH — one small sync read at start (no window, nothing else waits)
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")) as { name: string; productName?: string; version: string };
  const home = homedir();
  const userData = userDataDir(pkg.productName ?? pkg.name, process.env, home, PLATFORM);
  const settings = loadSettings(join(userData, "settings.json"));
  const folders = appDirs(process.env, home);
  const cacheDir = cacheDirFor(settings.cacheRoot, folders.cache);
  // the CLI's environment without the switches that started this process
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CK_HEADLESS_CLI;
  delete env.CK_HEADLESS_STOP;
  const nobody = (what: string) => {
    say(`${what}: a script run outside the app has no one to confirm it; run it in the app's Console (or write into the next free version, -o …_v###/, which replaces nothing)`);
    return Promise.resolve(false);
  };
  const out = new Printer((s, t) => (s === "err" ? process.stderr : process.stdout).write(t + "\n"));
  const ended = new Map<number, ConsoleBlock>();
  let wake: (() => void) | null = null;
  const c = new Console({
    registry: makeRegistry(),
    paths: realPathDeps(home),
    fs: consoleFs,
    startDir: process.cwd(),
    cli: () => cli,
    cliEnv: () => env,
    cliTemp: () => join(folders.cache, "console"),
    // only the runtime and models the app's settings name (the Engine page's choices); the CLI finds its own otherwise
    runtimeAllowed: (what, path) => {
      const chosen = what === "models" ? settings.modelsDir : settings.ortLibrary;
      return !!chosen && resolve(chosen) === path;
    },
    // the app's: the results folder, the cache folder, the folders allowed in its Console (the queue isn't here)
    // loop: NOT-WORTH — ≤ 100 folders, once per written path checked
    writeRoots: () => [settings.outputRoot, cacheDir, folders.cache, ...settings.consoleWriteFolders].filter((x): x is string => !!x),
    allowed: () => settings.consoleWriteFolders,
    setAllowed: () => {},
    bookmarks: () => settings.consoleBookmarks,
    setBookmarks: () => say("bookmarks made here aren't kept (the app keeps its own)"),
    variables: () => settings.consoleVariables,
    setVariables: () => say("set -p here lasts only this script (the app keeps its own variables)"),
    showInFolder: (p) => process.stdout.write(`${p}\n`),
    confirmAllow: (f) => nobody(`allow ${f}`),
    // no queue here: a GPU command runs as corridorkey render does on its own
    takeGpu: async () => null,
    // no queue here, so nothing else holds the card
    gpuBusy: () => null,
    releaseGpu: () => {},
    confirm: (r) => nobody(r.line),
    confirmScript: (r) => nobody(`${r.script}'s ${r.lines.length === 1 ? "line" : `${r.lines.length} lines`} that replace files`),
    elevation: new Elevation(),
    audit: new AuditLog(join(userData, "console-audit.jsonl")),
    // its own history: a cron job's lines don't fill the Console's ↑
    history: new History(join(userData, "console-history-headless.jsonl")),
    changed: (b) => {
      out.block(b);
      if (b.state !== "running") {
        ended.set(b.id, b);
        wake?.();
      }
    },
    sessionChanged: () => {},
    jobs: () => [],
    doctor: () => ({
      rows: [],
      // loop: NOT-WORTH — ≤ 100 folders
      folders: [...(settings.outputRoot ? [{ label: "Results folder", path: settings.outputRoot }] : []), ...settings.consoleWriteFolders.map((f) => ({ label: "Allowed folder", path: f }))],
    }),
    version: pkg.version,
  });
  // a farm's cancel (SIGTERM) or Ctrl+C: the script stops as the Console's Ctrl+C stops it; again: at once
  // lifetime: OK — the process ends with the script
  process.on("SIGINT", () => c.cancel());
  process.on("SIGTERM", () => c.cancel());
  if (process.env.CK_HEADLESS_STOP === "stdin") onStopLines(process.stdin, () => c.cancel());
  // loop: NOT-WORTH — starts the script [bounded: its checks; the script itself is waited for below]
  const b = await c.run(`run ${args.keepGoing ? "--keep-going " : ""}${quoteArg(resolve(args.file), { windows: PLATFORM === "win32" })}`);
  // loop: NOT-WORTH — waits for the script's block to end [bounded: the script's own end; SIGINT / SIGTERM stop it]
  while (!ended.has(b.id)) await new Promise<void>((r) => (wake = r));
  return statusOf(ended.get(b.id)!);
}

// run only when ck-cli starts it (it sets CK_HEADLESS_CLI); the tests import its functions
if (process.env.CK_HEADLESS_CLI !== undefined)
  // loop: NOT-WORTH — one script per process
  void main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      // error: SHOWN — said on stderr, exit 8 (the CLI's "the engine failed: a bug")
      say(`stopped: ${String((e as Error)?.message ?? e)}`);
      process.exit(8);
    },
  );
