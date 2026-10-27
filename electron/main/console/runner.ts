// The Console's runner (backlog row 95, docs/CONSOLE.md): every line the page sends is parsed here again with the shared
// parser and checked here, whatever the page showed. Never a system shell: built-ins run in this process; `corridorkey`
// runs as one fixed program with an argv (spawn, shell: false), never a command string.
//
// lifetime: at most ONE console job (a corridorkey run, or a `run` script) at a time; its child ends with the job
// (Ctrl+C: SIGTERM, the CLI stops cleanly with 143; a second Ctrl+C or the app's quit after the grace: the process
// group is killed). The CLI doesn't watch its parent (docs/CLI.md), so the app's quit always stops it (shutdown).
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Dirent, Stats } from "node:fs";
import { createInterface } from "node:readline";
import { posix, win32 } from "node:path";
import { naturalCompare } from "../media";
import { enumValue, parse, quoteArg, type Parsed, type ParseOptions } from "../../../src/shared/console/parse";
import { isBinary, LINES_MAX, TEXT_MAX, TextCount, textLines, treeLines, WC_MAX, type TreeNode } from "./files";
import { EXIT_MEANINGS, fullName, type ConsoleArg, type Registry } from "../../../src/shared/console/registry";
import type { ConsoleBlock, ConsoleEntry, ConsoleHistoryEntry, ConsoleSession, DoctorRow, Job as QueueJob } from "../../../src/shared/types";
import { farmExport, fileList, type FarmFormat, type FarmJob } from "./farm";
import { complete } from "./complete";
import type { Elevation } from "./elevation";
import { commandHelp, findLines, overview } from "./help";
import type { AuditLog, History } from "./logs";
import { answerWithin, checkWrite, expandHome, FS_ANSWER_MS, fsErrorText, nextVersion, resolveReal, type PathDeps } from "./paths";
import { expandHistory, hasExpansion } from "../../../src/shared/console/expand";
import { folderRange, frameToken, groupSequences, isFrameFile, sequenceOf, type Sequence } from "../../../src/shared/console/sequences";
import { commands, globRegExp, isCompound, leavesQuoteOpen, parseProgram, type CmdNode, type List } from "../../../src/shared/console/script";
import { tokenize } from "../../../src/shared/console/parse";
import { BOOKMARK_NAME, BOOKMARKS_MAX, VARIABLES_MAX, WRITE_FOLDERS_MAX } from "../settings";
import { expandVars, forWords, READ_ONLY, VALUE_MAX, VAR_NAME } from "../../../src/shared/console/vars";
import { matches, rankFolders } from "../../../src/shared/console/frecency";
import { fileSizeText, gibBytes } from "../../../src/shared/units";

/** Lines a block keeps (the newest); a long render's log can't grow the page or the pushes without bound. */
export const CONSOLE_LINES_KEPT = 2000;
const LINE_CHARS = 4000;
/**
 * The characters a block keeps (the newest whole lines): with BLOCKS_KEPT blocks on the page, at most ~50 M
 * characters in all, where 2000 lines of 4000 could make 1.6 G (senior review 2026-10-26 N6).
 */
export const CONSOLE_CHARS_KEPT = 256_000;
/** dir / ls rows (a plate folder can hold 100 000 frames). */
export const LIST_MAX = 5000;
/** dir's stats in all (a sequence's size is its frames'): past these, a size says "?" */
const DIR_STATS = 20_000;
/** A script (run) or job file read: at most this many bytes. */
const FILE_MAX = 1024 * 1024;
/** The quit's grace for a running corridorkey: it stops cleanly within it, else it is killed. */
export const QUIT_GRACE_MS = 7000;
/** The longest line the Console takes (the IPC check; a typed line is far shorter). */
export const LINE_MAX = 8192;

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

export interface ConsoleFs {
  readdir: (p: string) => Promise<Dirent[]>;
  stat: (p: string) => Promise<Stats>;
  /** the name itself, a link not followed (farm export never writes through one) */
  lstat: (p: string) => Promise<Stats>;
  readFile: (p: string, maxBytes: number) => Promise<string>;
  /** up to `length` bytes of a regular file from `start` (cat, head, tail, wc) */
  readRange: (p: string, start: number, length: number) => Promise<Buffer>;
  mkdir: (p: string) => Promise<void>;
  /** replaces the file at `p`, never writing through a link there (paths.ts replaceFile) */
  writeFile: (p: string, text: string) => Promise<void>;
  /** may this process write in the folder (doctor) */
  writable: (p: string) => Promise<boolean>;
  /** free bytes on the folder's disk (doctor) */
  freeBytes: (p: string) => Promise<number>;
}

/**
 * What a sudo confirmation shows: the line as typed, the command as it runs (each word quoted as the Console reads it,
 * without the Console's own --progress-format and temporary folder) and what it replaces: the files at the run's names
 * in each written folder. Control and bidi characters are shown as \u{…} (a crafted name can't add lines or reorder text).
 */
export interface ElevationRequest {
  line: string;
  command: string;
  targets: { path: string; files: number; bytes: number }[];
}

export interface ConsoleDeps {
  registry: Registry;
  paths: PathDeps;
  fs: ConsoleFs;
  /** how long a readdir / stat / lstat / realpath may take (FS_ANSWER_MS; tests shorten it) */
  fsAnswerMs?: number;
  /** the first folder (the results folder, else home) */
  startDir: string;
  /** the shipped corridorkey (engineFind.ts findCli), or null */
  cli: () => string | null;
  /** its environment (engine.ts rustEngineEnv + the app's models, runtime and TensorRT cache) */
  cliEnv: () => NodeJS.ProcessEnv;
  /** render's --temp when none is given: inside the app's cache (a chosen folder) */
  cliTemp: () => string;
  /** --models / --ort: only what the Engine page lists (a library is code: never one the page names freely) */
  runtimeAllowed: (what: "models" | "ort", path: string) => boolean;
  /** the folders the Console may write to (the allowed ones among them) */
  writeRoots: () => string[];
  /** the folders allowed with `allow` (settings.consoleWriteFolders) */
  allowed: () => readonly string[];
  /** saves them (index.ts: settings, persisted) */
  setAllowed: (folders: string[]) => void;
  /** the bookmarks (settings.consoleBookmarks): name → absolute folder */
  bookmarks: () => Readonly<Record<string, string>>;
  /** saves them (index.ts: settings, persisted) */
  setBookmarks: (b: Record<string, string>) => void;
  /** the kept variables (settings.consoleVariables, `set -p`) */
  variables: () => Readonly<Record<string, string>>;
  /** saves them (index.ts: settings, persisted) */
  setVariables: (v: Record<string, string>) => void;
  /** open / start: the file manager shows the path (index.ts: shell.showItemInFolder; it never opens or runs a file) */
  showInFolder: (path: string) => void;
  /** `allow`'s native confirmation, naming the folder; true: confirmed */
  confirmAllow: (folder: string) => Promise<boolean>;
  /**
   * take the graphics card for a job: null when taken, else why not (the queue runs); resolves once the engines it
   * stopped (the memory estimate's, the background TensorRT build's) have exited, so their memory is free
   */
  takeGpu: () => Promise<string | null>;
  /** why corridorkey can't touch the card now (the queue keys), or null: `info` asks it (it starts CUDA) without taking the card */
  gpuBusy: () => string | null;
  releaseGpu: () => void;
  /** the native confirmation (index.ts: dialog.showMessageBox); true: confirmed */
  confirm: (req: ElevationRequest) => Promise<boolean>;
  /** a script's one confirmation, up front, listing all its lines that replace files */
  confirmScript: (req: ScriptElevationRequest) => Promise<boolean>;
  elevation: Elevation;
  audit: AuditLog;
  history: History;
  /** a block changed (index.ts pushes it, throttled) */
  changed: (block: ConsoleBlock) => void;
  /** the session (folder, elevation, running) changed */
  sessionChanged: () => void;
  spawn?: SpawnFn;
  /** the second Ctrl+C / the quit: the child's whole process group (tree on Windows) */
  killTree?: (pid: number) => void;
  now?: () => number;
  /** doctor's checks of the app's own (ffmpeg, TensorRT) and the folders the Console writes to, labelled */
  doctor: () => { rows: DoctorRow[]; folders: { label: string; path: string }[] };
  /** the queue's jobs (farm export writes them with their settings) */
  jobs: () => readonly QueueJob[];
  /** the app's version: its corridorkey's too (built together, one number: ck-cli lib.rs VERSION) */
  version: string;
}

interface Job {
  block: ConsoleBlock;
  child: ChildProcess | null;
  cancels: number;
  /** a script whose lines that replace files were confirmed up front (its own, never the session's elevation) */
  scriptGrant?: boolean;
  /** a long built-in (du, tree, wc, j): Ctrl+C stops it at its next entry, chunk or folder */
  builtin?: boolean;
  /** a script's confirmed lines with `${…}`, as they were shown filled in: each must run as shown */
  confirmed?: Map<CmdNode, string>;
}

/**
 * A script's lines that replace files, as its one confirmation lists them (control and bidi characters shown): each
 * with its `${…}` filled in where the values are known before it runs (else said), and what the lines known now would
 * replace, counted as the single command's dialog counts it (senior review 2026-10-27 S2).
 */
export interface ScriptElevationRequest {
  script: string;
  lines: string[];
  targets: ElevationRequest["targets"];
  /** the script changes folder (cd, pushd, popd, j): a relative folder is resolved when its line runs, not counted */
  movesFolder: boolean;
}

const AUDIT_FAILED = "Not run: the audit log couldn't record it (every elevated command is logged first; see the app's log for why).";

/** The CLI's progress as JSON events (docs/CLI.md "Progress"): the Console shows them itself. */
const PROGRESS = ["--progress-format", "json"];

export class Console {
  private cwd: string;
  /** the folder before the last cd (cd -) */
  private prevCwd: string | null = null;
  /** pushd's folders, newest first (this session only) */
  private stack: string[] = [];
  /** the variables (`set`): this session's, the kept ones (`set -p`, settings) loaded at start */
  private readonly vars = new Map<string, string>();
  /** the last command's exit status (`${status}`) */
  private status = 0;
  private job: Job | null = null;
  private nextId = 1;
  /** the characters in each block's kept lines (CONSOLE_CHARS_KEPT) */
  private readonly chars = new WeakMap<ConsoleBlock, number>();
  private expiryTimer: NodeJS.Timeout | null = null;
  private readonly spawnFn: SpawnFn;
  private readonly now: () => number;
  private readonly opts: ParseOptions;
  /** set by shutdown(): from then on nothing spawns */
  private closing = false;

  constructor(private readonly d: ConsoleDeps) {
    // every read of the file system answers in time, or says the drive or share didn't (senior review 2026-10-26 N11)
    const ms = d.fsAnswerMs ?? FS_ANSWER_MS;
    const timed =
      <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
      (...a: A) =>
        answerWithin(f(...a), ms);
    this.d = { ...d, fs: { ...d.fs, readdir: timed(d.fs.readdir), stat: timed(d.fs.stat), lstat: timed(d.fs.lstat) }, paths: { ...d.paths, realpath: timed(d.paths.realpath) } };
    this.cwd = d.startDir;
    this.spawnFn = d.spawn ?? nodeSpawn;
    this.now = d.now ?? Date.now;
    this.opts = { windows: d.paths.platform === "win32" };
    // loop: NOT-WORTH — ≤ VARIABLES_MAX kept variables, once at start
    for (const [k, v] of Object.entries(d.variables())) this.vars.set(k, v);
  }

  session(): ConsoleSession {
    return { cwd: this.cwd, elevatedUntil: this.d.elevation.expiresAt, running: this.job?.block.line ?? null, cliFound: this.d.cli() !== null };
  }

  /**
   * Run a typed line. Resolves with its block once it is done, or (corridorkey, run) once it has started. History
   * expansion (`!!`, `!N`, `!-N`, `!prefix`, `!$`, `^old^new`: expand.ts) first, typed lines only: the expanded line is
   * what runs, what its block shows (with what was typed) and what the history keeps, as in bash.
   */
  async run(line: string): Promise<ConsoleBlock> {
    let typed: string | null = null;
    if (hasExpansion(line, this.opts)) {
      await this.d.history.loaded;
      // loop: NOT-WORTH — the history's lines (≤ its cap), once per line with a ! or ^ to expand
      const past = this.d.history.entries("", Number.MAX_SAFE_INTEGER).reverse();
      const x = expandHistory(line, past, this.opts);
      if ("error" in x) return this.finish(this.block(line, null), "refused", x.error);
      typed = line;
      line = x.line;
    }
    // kept with its folder (a leading space: not kept), and how it ended once it has; with its ${name}s as typed (a
    // later !! fills them in again)
    const n = this.d.history.add(line, this.cwd);
    const ended = (r: { done: Promise<ConsoleBlock> }) =>
      // loop: NOT-WORTH — one async history append per line's end [bounded: a local file write]
      void r.done.then(async (b) => {
        this.status = statusOf(b);
        const k = await n;
        if (k !== null) await this.d.history.ended(k, b.exitCode, b.state);
      });
    // ; && || for if time: the line runs as a script (script.ts), each command filled in and checked when it runs
    const prog = parseProgram(line, this.opts);
    if ("error" in prog || isCompound(prog.list)) {
      const b = this.block(line, null);
      if (typed !== null) this.note(b, "info", `from ${typed}`);
      const r =
        "error" in prog
          ? (() => {
              b.errors = [prog.error];
              const x = this.finish(b, "refused", prog.error.message);
              return { block: x, done: Promise.resolve(x) };
            })()
          : await this.program(b, prog.list, null, false);
      ended(r);
      return r.block;
    }
    const v = this.expand(line);
    if ("error" in v) {
      const b = this.finish(this.block(line, null), "refused", v.error);
      this.status = 2;
      // loop: NOT-WORTH — one async history append per line's end [bounded: a local file write]
      void n.then(async (k) => {
        if (k !== null) await this.d.history.ended(k, null, b.state);
      });
      return b;
    }
    if (v.changed) typed ??= line;
    const r = await this.runLine(v.line, null, typed);
    ended(r);
    // a job's block finishes later (its updates are pushed); a built-in's is finished here
    return r.block;
  }

  /**
   * A queue job started (teach by echo): its corridorkey line as an informational block, saying where it came from.
   * Nothing runs, and it isn't kept in the history (it wasn't typed).
   */
  echo(line: string, what: string): void {
    const b = this.block(line, null);
    b.echo = what;
    b.state = "done";
    b.finishedAt = b.startedAt;
    this.d.changed(b);
  }

  /** Ctrl+C: SIGTERM (the CLI stops after the frame it is on, cleanly, 143); again: the whole group at once. */
  cancel(): void {
    const job = this.job;
    if (!job) return;
    job.cancels++;
    const pid = job.child?.pid;
    if (job.cancels === 1) {
      this.note(job.block, "info", job.child ? "Stopping after the current frame (Ctrl+C again stops it at once)…" : job.builtin ? "Stopping…" : "Stopping the script after this command…");
      // Windows has no SIGTERM for a console program: the tree is ended (the output stays safe: docs/CLI.md)
      if (pid && this.d.paths.platform === "win32") this.killTree(pid);
      else job.child?.kill("SIGTERM");
    } else if (pid) {
      this.note(job.block, "info", "Stopped at once.");
      this.killTree(pid);
    }
  }

  async complete(line: string, cursor: number) {
    return complete(line, cursor, this.cwd, {
      registry: this.d.registry,
      platform: this.d.paths.platform,
      home: this.d.paths.home,
      readdir: this.d.fs.readdir,
      isDir: async (p) => (await this.d.fs.stat(p).catch(() => null))?.isDirectory() ?? false,
      bookmarks: this.d.bookmarks,
    });
  }

  history(query: string): ConsoleHistoryEntry[] {
    return this.d.history.entries(query);
  }

  /** sudo -k, a screen lock, sleep, quit: elevation ends (and the audit log says why). */
  dropElevation(reason: string): void {
    if (!this.d.elevation.drop()) return;
    void this.d.audit.append({ event: "dropped", reason });
    this.clearExpiry();
    this.d.sessionChanged();
  }

  /** The app quits: elevation dropped, a running corridorkey stopped (SIGTERM, then killed after `graceMs`). */
  shutdown(graceMs = QUIT_GRACE_MS): Promise<void> {
    this.closing = true;
    this.dropElevation("the app quit");
    const child = this.job?.child;
    if (!child) {
      // a script between two lines: it runs no further line
      this.cancel();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      // loop: NOT-WORTH — one wait at quit [bounded: graceMs, then the group is killed]
      const timer = setTimeout(() => {
        if (child.pid) this.killTree(child.pid);
        resolve();
      }, graceMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.cancel();
    });
  }

  // --- execution ---

  /** The line with its `${name}`s filled in (vars.ts): the read-only ones, then the variables set. */
  private expand(line: string, scope?: ReadonlyMap<string, string>) {
    return expandVars(line, (name) => scope?.get(name) ?? this.lookup(name), this.opts);
  }

  private lookup(name: string): string | undefined {
    const now = new Date(this.now());
    const p = (n: number) => String(n).padStart(2, "0");
    switch (name) {
      case "cwd":
        return this.cwd;
      case "home":
        return this.d.paths.home;
      case "date":
        return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
      case "time":
        return `${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
      case "status":
        return String(this.status);
    }
    return this.vars.get(name);
  }

  /** set [-p] name=value…: a variable for later lines (-p: kept after a restart); a name alone prints it; alone: all. */
  private set(b: ConsoleBlock, assigns: string[], keep: boolean): ConsoleBlock {
    const kept = this.d.variables();
    if (!assigns.length) {
      // loop: NOT-WORTH — ≤ a few hundred variables, sorted once per set
      const names = [...this.vars.keys()].sort(naturalCompare);
      // loop: NOT-WORTH — five names
      const own = READ_ONLY.map((k) => `${k}=${this.lookup(k)}  (the Console's own)`);
      b.paths = [this.cwd, this.d.paths.home];
      // loop: NOT-WORTH — as above
      return this.finish(b, "done", ...names.map((k) => `${k}=${this.vars.get(k)}${Object.hasOwn(kept, k) ? "  (kept)" : ""}`), ...own);
    }
    const next = { ...kept };
    const lines: string[] = [];
    // loop: NOT-WORTH — the line's few assignments
    for (const a of assigns) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      if (!VAR_NAME.test(name)) return this.finish(b, "refused", `${name} can't be a variable's name: a letter or _ first, then letters, digits, _ (set name=value).`);
      if ((READ_ONLY as readonly string[]).includes(name)) return this.finish(b, "refused", `\${${name}} is the Console's own: it can't be set.`);
      if (eq < 0) {
        const v = this.lookup(name);
        if (v === undefined) return this.finish(b, "failed", `No variable ${name} (set lists them).`);
        lines.push(`${name}=${v}`);
        continue;
      }
      const value = a.slice(eq + 1);
      if (value.length > VALUE_MAX || value.includes("\0")) return this.finish(b, "refused", `${name}: a value is at most ${VALUE_MAX} characters, without NUL.`);
      if (!this.vars.has(name) && this.vars.size >= VARIABLES_SESSION_MAX) return this.finish(b, "refused", `${VARIABLES_SESSION_MAX} variables already: unset some first.`);
      // a kept variable stays kept (set changes it everywhere); -p keeps a new one
      if (keep || Object.hasOwn(kept, name)) {
        if (!Object.hasOwn(next, name) && Object.keys(next).length >= VARIABLES_MAX) return this.finish(b, "refused", `${VARIABLES_MAX} kept variables already: unset some first.`);
        next[name] = value;
      }
      this.vars.set(name, value);
    }
    // loop: NOT-WORTH — ≤ VARIABLES_MAX names
    if (Object.keys(next).some((k) => next[k] !== kept[k]) || Object.keys(next).length !== Object.keys(kept).length) this.d.setVariables(next);
    return this.finish(b, "done", ...lines);
  }

  /** unset name…: gone, the kept one too. */
  private unset(b: ConsoleBlock, names: string[]): ConsoleBlock {
    const kept = { ...this.d.variables() };
    let save = false;
    // loop: NOT-WORTH — the line's few names
    for (const n of names) {
      if ((READ_ONLY as readonly string[]).includes(n)) return this.finish(b, "refused", `\${${n}} is the Console's own: it can't be unset.`);
      if (!this.vars.delete(n)) return this.finish(b, "failed", `No variable ${n} (set lists them).`);
      if (Object.hasOwn(kept, n)) {
        delete kept[n];
        save = true;
      }
    }
    if (save) this.d.setVariables(kept);
    return this.finish(b, "done");
  }

  private block(line: string, parent: number | null): ConsoleBlock {
    return {
      id: this.nextId++,
      line,
      parent,
      cwd: this.cwd,
      argv: null,
      elevated: false,
      state: "running",
      exitCode: null,
      exitMeaning: null,
      startedAt: this.now(),
      finishedAt: null,
      progress: null,
      status: null,
      lines: [],
      linesDropped: 0,
      entries: null,
      errors: [],
      clear: false,
    };
  }

  private note(b: ConsoleBlock, kind: "out" | "err" | "info", text: string): void {
    const t = text.length > LINE_CHARS ? text.slice(0, LINE_CHARS) + "…" : text;
    b.lines.push({ kind, text: t });
    let chars = (this.chars.get(b) ?? 0) + t.length;
    let drop = 0;
    // loop: HOT-PATH-OK — usually no turn; drops whole lines from the front past CONSOLE_LINES_KEPT or CONSOLE_CHARS_KEPT (the newest stays)
    while (drop < b.lines.length - 1 && (b.lines.length - drop > CONSOLE_LINES_KEPT || chars > CONSOLE_CHARS_KEPT)) chars -= b.lines[drop++].text.length;
    if (drop) b.linesDropped += b.lines.splice(0, drop).length;
    this.chars.set(b, chars);
    if (b.state === "running") this.d.changed(b);
  }

  private finish(b: ConsoleBlock, state: ConsoleBlock["state"], ...lines: string[]): ConsoleBlock {
    // loop: NOT-WORTH — a few lines
    for (const l of lines) this.note(b, state === "done" ? "out" : "err", l);
    b.state = state;
    b.finishedAt = this.now();
    if (b.exitCode === null) b.exitCode = state === "done" ? 0 : null;
    this.d.changed(b);
    return b;
  }

  /**
   * One line: parsed, checked, run. `done` settles when it has finished (a script waits on it). Whatever a built-in
   * throws (a file whose stat works but whose open doesn't) ends its block failed, in words: never a rejected call
   * with no block (senior review 2026-10-27 M4).
   */
  private async runLine(line: string, parent: number | null, typed: string | null = null): Promise<{ block: ConsoleBlock; done: Promise<ConsoleBlock> }> {
    const b = this.block(line, parent);
    // a history expansion: the block shows the line that runs, and what was typed
    if (typed !== null) this.note(b, "info", `from ${typed}`);
    try {
      return await this.runParsed(b, line, parent);
    } catch (e) {
      // error: SHOWN — the block says what failed, in words (fsErrorText)
      const path = (e as NodeJS.ErrnoException | null)?.path;
      const x = this.finish(b, "failed", `${line.trim().split(/\s+/)[0]}: ${path ? fsErrorText(e, path) : String((e as Error)?.message ?? e)}.`);
      return { block: x, done: Promise.resolve(x) };
    }
  }

  private async runParsed(b: ConsoleBlock, line: string, parent: number | null): Promise<{ block: ConsoleBlock; done: Promise<ConsoleBlock> }> {
    const now = (x: ConsoleBlock) => ({ block: x, done: Promise.resolve(x) });
    const p = parse(line, this.d.registry, this.opts);
    if (p.errors.length) {
      b.errors = p.errors;
      // loop: NOT-WORTH — a line's few mistakes
      return now(this.finish(b, "refused", ...p.errors.map((e) => e.message)));
    }
    const cmd = p.command;
    if (!cmd) return now(this.finish(b, "done"));
    // sudo on a line that replaces nothing: said, then run as it is (backlog 107)
    // loop: NOT-WORTH — the line's few options
    if (p.sudo && !p.options.some((o) => o.arg.destructive)) this.note(b, "info", "sudo isn't needed for this (it replaces no files): ran it as it is.");
    // as the CLI prints it (clap: "corridorkey 1.0.0", "corridorkey-render 1.0.0"), without running it
    if (p.version) return now(this.finish(b, "done", `${cmd === this.d.registry.cli ? "corridorkey" : `corridorkey-${cmd.name}`} ${this.d.version}`));
    if (p.help) return now(this.finish(b, "done", ...(cmd.name === "help" && cmd.kind === "builtin" ? overview(this.d.registry) : commandHelp(this.d.registry, cmd))));
    if (cmd.kind === "cli") return this.cli(b, p, parent !== null);
    // loop: NOT-WORTH — the line's few options
    const has = (id: string) => p.options.some((o) => o.arg.id === id);
    // loop: NOT-WORTH — the line's few positionals
    const pos = (id: string) => p.positionals.filter((x) => x.arg.id === id).map((x) => x.value);
    switch (cmd.name) {
      case "help": {
        const name = pos("command")[0];
        const c = name ? parse(name, this.d.registry, this.opts).command : null;
        if (name && !c) return now(this.finish(b, "refused", `No command ${name}. help lists them.`));
        // loop: NOT-WORTH — the line's few options
        const keyword = p.options.find((o) => o.arg.id === "keyword")?.value;
        if (keyword) return now(this.finish(b, "done", ...findLines(this.d.registry, [keyword])));
        return now(this.finish(b, "done", ...(c ? commandHelp(this.d.registry, c) : overview(this.d.registry))));
      }
      case "apropos":
        return now(this.finish(b, "done", ...findLines(this.d.registry, pos("term"))));
      case "pwd":
        return now(this.finish(b, "done", this.cwd));
      case "cd": {
        // loop: NOT-WORTH — the line's one positional
        const back = p.positionals.some((x) => x.value === "-" && !p.words[x.word].quoted);
        return now(await this.cd(b, pos("folder")[0], back));
      }
      case "bookmark":
        return now(await this.bookmark(b, pos("name")[0], pos("folder")[0], has("delete")));
      case "bookmarks":
        return now(this.bookmark(b, undefined, undefined, false) as ConsoleBlock);
      case "j":
        return now(await this.slotted(b, parent !== null, (stop) => this.jump(b, pos("parts"), stop)));
      case "pushd":
        return now(await this.pushd(b, pos("folder")[0]));
      case "popd": {
        const to = this.stack[0];
        if (to === undefined) return now(this.finish(b, "failed", "Nothing to go back to: pushd <folder> remembers where you are first."));
        const r = await this.go(to);
        if (typeof r !== "string") return now(this.finish(b, "failed", r.error));
        this.stack.shift();
        return now(this.dirsList(b));
      }
      case "dirs":
        return now(this.dirsList(b));
      case "set":
        return now(this.set(b, pos("assign"), has("persist")));
      case "unset":
        return now(this.unset(b, pos("names")));
      case "echo":
        return now(this.finish(b, "done", pos("words").join(" ")));
      case "dir":
        return now(await this.dir(b, pos("folder")[0], p));
      case "open": {
        const a = this.d.paths.platform === "win32" ? win32 : posix;
        const given = this.at(pos("path")[0] ?? ".");
        if (given === null) return now(this.finish(b, "failed", noBookmark(pos("path")[0])));
        let path = a.resolve(this.cwd, expandHome(given, this.d.paths));
        // a frame pattern: its first frame
        const pat = await this.patternAt(path);
        if (pat && !pat.seq) return now(this.finish(b, "failed", noFrames(pat, this.opts)));
        if (pat?.seq) path = a.join(pat.dir, pat.seq.names[0]);
        // loop: NOT-WORTH — one async stat per open
        const st = await this.d.fs.stat(path).catch((e: unknown) => e as Error);
        if (st instanceof Error) return now(this.finish(b, "failed", `Can't show it: ${fsErrorText(st, path)}. Tab completes a name.`));
        this.d.showInFolder(path);
        return now(this.finish(b, "done"));
      }
      case "allow":
        return now(await this.allow(b, pos("folder")[0]));
      case "version":
        return now(this.finish(b, "done", `CorridorKey ${this.d.version} (the app and its corridorkey command line: one version)`));
      case "cls":
        b.clear = true;
        return now(this.finish(b, "done"));
      case "history":
        return now(await this.historyBlock(b, has("audit"), pos("which")[0]));
      case "sudo":
        this.dropElevation("sudo -k");
        return now(this.finish(b, "done", "Not elevated."));
      case "run":
        return this.script(b, pos("file")[0], parent !== null, has("keep-going"));
      case "time":
        return now(this.finish(b, "refused", "time goes first on the line: time sudo render …"));
      case "cat":
        return now(await this.cat(b, pos("files")));
      case "head":
      case "tail":
        // loop: NOT-WORTH — the line's few options
        return now(await this.headTail(b, pos("file")[0], cmd.name === "tail", num(Number(p.options.find((o) => o.arg.id === "lines")?.value ?? 10))));
      case "wc":
        return now(await this.slotted(b, parent !== null, (stop) => this.wc(b, pos("files"), stop)));
      case "du":
        return now(await this.slotted(b, parent !== null, (stop) => this.du(b, pos("folders"), stop)));
      case "tree":
        // loop: NOT-WORTH — the line's few options
        return now(await this.slotted(b, parent !== null, (stop) => this.tree(b, pos("folder")[0], num(Number(p.options.find((o) => o.arg.id === "level")?.value ?? 2)), has("all"), stop)));
      case "farm":
        return now(await this.farm(b, p, parent !== null));
      case "doctor":
        return now(await this.doctor(b, has("json")));
    }
    return now(this.finish(b, "refused", `${cmd.name} isn't a command this Console runs.`));
  }

  /**
   * A long built-in (du, tree, wc, j) as a job (senior review 2026-10-27 S6): the one slot (in a program: the program's),
   * so nothing else starts while it reads, and `stop` says Ctrl+C was pressed (it checks at each entry, chunk or folder).
   */
  private async slotted(b: ConsoleBlock, inScript: boolean, run: (stop: () => boolean) => Promise<ConsoleBlock>): Promise<ConsoleBlock> {
    const held = this.job;
    if (held && !(inScript && held.block.id === b.parent)) return this.finish(b, "refused", `Busy with ${held.block.line} (one command at a time; Ctrl+C stops it).`);
    const job: Job = held ?? { block: b, child: null, cancels: 0, builtin: true };
    if (!held) {
      this.job = job;
      this.d.sessionChanged();
    }
    try {
      return await run(() => job.cancels > 0);
    } finally {
      if (!held) {
        this.job = null;
        this.d.sessionChanged();
      }
    }
  }

  private async cd(b: ConsoleBlock, to: string | undefined, back = false): Promise<ConsoleBlock> {
    if (back) {
      if (this.prevCwd === null) return this.finish(b, "failed", "No previous folder yet: cd - goes back to the folder you were in before the last cd.");
      to = this.prevCwd;
    }
    const r = await this.go(to);
    if (typeof r !== "string") return this.finish(b, "failed", r.error);
    // silent on success (the bar and the prompt show the folder); cd - prints where it went, as bash does
    if (back) b.paths = [r];
    return back ? this.finish(b, "done", r) : this.finish(b, "done");
  }

  /** The Console's folder changes to `to` (home when none; a bookmark, a frame pattern's folder): the folder, or why not. */
  private async go(to: string | undefined): Promise<string | { error: string }> {
    if (to !== undefined) {
      const m = this.at(to);
      if (m === null) return { error: noBookmark(to) };
      to = m;
    }
    let dir = "";
    try {
      // a frame pattern (cd plates/plate.####.exr): its folder
      dir = await resolveReal((to !== undefined && (await this.patternFolder(to))) || (to ?? this.d.paths.home), this.cwd, this.d.paths);
      // loop: NOT-WORTH — one async stat per cd
      if (!(await this.d.fs.stat(dir)).isDirectory()) return { error: `${dir} isn't a folder.` };
    } catch (e) {
      // error: SHOWN — the block says why
      return { error: `Can't go to ${to ?? "~"}: ${fsErrorText(e, dir || to || this.d.paths.home)}. pwd says where you are, dir lists the folders here, Tab completes a name.` };
    }
    this.prevCwd = this.cwd;
    this.cwd = dir;
    this.d.sessionChanged();
    return dir;
  }

  /**
   * allow <folder>: the Console may write there from now on (across restarts), once the native confirmation says yes
   * and the audit log has it; a folder it may already write to needs none. allow alone: the folders allowed.
   */
  private async allow(b: ConsoleBlock, folder: string | undefined): Promise<ConsoleBlock> {
    const list = this.d.allowed();
    if (folder === undefined) {
      if (!list.length) return this.finish(b, "done", "No folder allowed yet: allow <folder> lets the Console write in one (after you confirm).");
      // loop: NOT-WORTH — ≤ 100 folders
      return this.finish(b, "done", "The Console may also write in (App settings → Console removes them):", ...list.map((f) => `  ${f}`));
    }
    const m = this.at(folder);
    if (m === null) return this.finish(b, "failed", noBookmark(folder));
    folder = m;
    let dir = "";
    try {
      // a frame pattern (allow key/key.####.exr): its folder
      dir = await resolveReal((await this.patternFolder(folder)) ?? folder, this.cwd, this.d.paths);
      // loop: NOT-WORTH — one async stat per allow
      if (!(await this.d.fs.stat(dir)).isDirectory()) return this.finish(b, "failed", `${dir} isn't a folder: allow takes a folder (it covers every folder inside it).`);
    } catch (e) {
      // error: SHOWN — the block says why
      return this.finish(b, "failed", `Can't allow ${folder}: ${fsErrorText(e, dir || folder)}. Tab completes a folder's name.`);
    }
    if ((await checkWrite(dir, this.cwd, this.d.writeRoots(), this.d.paths)).ok) return this.finish(b, "done", `The Console may already write in ${dir}.`);
    if (list.length >= WRITE_FOLDERS_MAX) return this.finish(b, "refused", `${WRITE_FOLDERS_MAX} folders are allowed already: remove one in App settings → Console first.`);
    if (!(await this.d.confirmAllow(visible(dir)))) return this.finish(b, "refused", "Not allowed: the confirmation was cancelled.");
    if (!(await this.d.audit.append({ event: "allowed", targets: [dir] }))) return this.finish(b, "refused", "Not allowed: the audit log couldn't record it (see the app's log for why).");
    this.d.setAllowed([...list, dir]);
    return this.finish(b, "done", `The Console may now write in ${dir} and every folder inside it (App settings → Console lists it and removes it).`);
  }

  /** App settings → Console's Remove: the folder is no longer writable (no confirmation: it only narrows), audited. */
  async disallow(folder: string): Promise<boolean> {
    const list = this.d.allowed();
    if (!list.includes(folder)) return false;
    // loop: NOT-WORTH — ≤ 100 folders
    this.d.setAllowed(list.filter((f) => f !== folder));
    // loop: NOT-WORTH — one async append per removal [bounded: a local file write]
    await this.d.audit.append({ event: "removed", targets: [folder] });
    return true;
  }

  /**
   * `@name` (or `@name/more`): the bookmark's folder; null for a bookmark there isn't; anything else as it is. A frame
   * token's `@@@@` never starts with a letter or digit, so it is never read as one.
   */
  private at(path: string): string | null {
    const m = /^@([^\\/]+)(.*)$/.exec(path);
    if (!m || !BOOKMARK_NAME.test(m[1])) return path;
    const marks = this.d.bookmarks();
    return Object.hasOwn(marks, m[1]) ? marks[m[1]] + m[2] : null;
  }

  /** bookmark <name> [folder]: saved (across restarts); -d removes it; no name: the list. */
  private bookmark(b: ConsoleBlock, name: string | undefined, folder: string | undefined, remove: boolean): ConsoleBlock | Promise<ConsoleBlock> {
    const all = this.d.bookmarks();
    if (name === undefined) {
      // loop: NOT-WORTH — ≤ BOOKMARKS_MAX bookmarks, sorted once per list
      const names = Object.keys(all).sort(naturalCompare);
      if (!names.length) return this.finish(b, "done", "No bookmarks yet: bookmark <name> names the current folder, then cd @name goes there.");
      // loop: NOT-WORTH — as above
      const w = Math.max(...names.map((n) => n.length + 1));
      // loop: NOT-WORTH — as above
      b.paths = names.map((n) => all[n]);
      // loop: NOT-WORTH — as above
      return this.finish(b, "done", ...names.map((n) => `${`@${n}`.padEnd(w)}  ${all[n]}`));
    }
    if (!BOOKMARK_NAME.test(name)) return this.finish(b, "refused", `${name} can't be a bookmark's name: a letter or digit first, then letters, digits, _ . or - (at most 64).`);
    if (remove) {
      if (folder !== undefined) return this.finish(b, "refused", "bookmark -d takes only the name.");
      if (!Object.hasOwn(all, name)) return this.finish(b, "failed", `No bookmark ${name} (bookmarks lists them).`);
      const rest = { ...all };
      delete rest[name];
      this.d.setBookmarks(rest);
      return this.finish(b, "done", `Removed @${name} (it was ${all[name]}).`);
    }
    if (!Object.hasOwn(all, name) && Object.keys(all).length >= BOOKMARKS_MAX) return this.finish(b, "refused", `${BOOKMARKS_MAX} bookmarks already: bookmark -d <name> removes one first.`);
    return (async () => {
      let dir = this.cwd;
      if (folder !== undefined) {
        const m = this.at(folder);
        if (m === null) return this.finish(b, "failed", noBookmark(folder));
        try {
          dir = await resolveReal((await this.patternFolder(m)) ?? m, this.cwd, this.d.paths);
          // loop: NOT-WORTH — one async stat per bookmark
          if (!(await this.d.fs.stat(dir)).isDirectory()) return this.finish(b, "failed", `${dir} isn't a folder: a bookmark names a folder.`);
        } catch (e) {
          // error: SHOWN — the block says why
          return this.finish(b, "failed", `Can't bookmark ${folder}: ${fsErrorText(e, dir)}. Tab completes a folder's name.`);
        }
      }
      const was = all[name];
      this.d.setBookmarks({ ...all, [name]: dir });
      return this.finish(b, "done", `@${name} is ${dir}${was && was !== dir ? ` (was ${was})` : ""}: cd @${name} goes there.`);
    })();
  }

  /** j <part…>: the best-ranked folder of the history's that matches and is still a folder; alone: the ranking. */
  private async jump(b: ConsoleBlock, parts: string[], stop: () => boolean): Promise<ConsoleBlock> {
    await this.d.history.loaded;
    // loop: NOT-WORTH — the history's lines (≤ its cap), once per j
    const ranked = rankFolders(this.d.history.entries("", Number.MAX_SAFE_INTEGER), this.now());
    if (!parts.length) {
      if (!ranked.length) return this.finish(b, "done", "No folders in the history yet: j learns the folders you type commands in.");
      // loop: NOT-WORTH — the 20 best
      // loop: NOT-WORTH — as above
      b.paths = ranked.slice(0, JUMP_LISTED).map((r) => r.folder);
      // loop: NOT-WORTH — as above
      return this.finish(b, "done", ...ranked.slice(0, JUMP_LISTED).map((r) => `${r.score.toFixed(2).padStart(7)}  ${r.folder}`));
    }
    // loop: NOT-WORTH — the history's folders, best first; one async stat per match until one is a folder [bounded: the history's folders (≤ 5000 lines); Ctrl+C at each]
    for (const r of ranked) {
      if (r.folder === this.cwd || !matches(r.folder, parts)) continue;
      const st = await this.d.fs.stat(r.folder).catch(() => null);
      if (stop()) return this.finish(b, "cancelled");
      if (!st?.isDirectory()) continue;
      const to = await this.go(r.folder);
      if (typeof to === "string") b.paths = [to];
      return typeof to === "string" ? this.finish(b, "done", to) : this.finish(b, "failed", to.error);
    }
    return this.finish(b, "failed", `No folder in the history matches ${parts.join(" ")} (j alone lists them; cd goes anywhere).`);
  }

  /** pushd [folder]: cd there, the folder before remembered; alone: swap with the newest remembered. */
  private async pushd(b: ConsoleBlock, folder: string | undefined): Promise<ConsoleBlock> {
    const from = this.cwd;
    if (folder === undefined) {
      const to = this.stack[0];
      if (to === undefined) return this.finish(b, "failed", "Nothing to swap with: pushd <folder> remembers where you are first.");
      const r = await this.go(to);
      if (typeof r !== "string") return this.finish(b, "failed", r.error);
      this.stack[0] = from;
      return this.dirsList(b);
    }
    if (this.stack.length >= STACK_MAX) return this.finish(b, "refused", `pushd remembers ${STACK_MAX} folders at most: popd first.`);
    const r = await this.go(folder);
    if (typeof r !== "string") return this.finish(b, "failed", r.error);
    this.stack.unshift(from);
    return this.dirsList(b);
  }

  /** dirs: where you are (0), then pushd's folders, newest first. */
  private dirsList(b: ConsoleBlock): ConsoleBlock {
    // the page shows the folders shortened (~, the middle as …)
    b.paths = [this.cwd, ...this.stack];
    // loop: NOT-WORTH — ≤ STACK_MAX folders
    return this.finish(b, "done", ...b.paths.map((f, i) => `${String(i).padStart(2)}  ${f}`));
  }

  private async dir(b: ConsoleBlock, folder: string | undefined, p: Parsed): Promise<ConsoleBlock> {
    // loop: NOT-WORTH — the line's few options
    const has = (id: string) => p.options.some((o) => o.arg.id === id);
    // ls: -t newest first, -S largest first, -r the other way; DOS /o: n name, s smallest first, d oldest first, -x reversed
    // loop: NOT-WORTH — as above
    const order = p.options.find((o) => o.arg.id === "order")?.value ?? null;
    let by: "name" | "time" | "size" = has("time") ? "time" : has("size") ? "size" : "name";
    let reverse = has("reverse");
    if (order) {
      by = order.endsWith("d") ? "time" : order.endsWith("s") ? "size" : "name";
      // DOS's d and s are oldest and smallest first: ls's -t and -S the other way round
      reverse = (by !== "name") !== order.startsWith("-");
    }
    const a = this.d.paths.platform === "win32" ? win32 : posix;
    if (folder !== undefined) {
      const m = this.at(folder);
      if (m === null) return this.finish(b, "failed", noBookmark(folder));
      folder = m;
    }
    let dir = a.resolve(this.cwd, expandHome(folder ?? ".", this.d.paths));
    // a pattern typed unquoted in the file name (ls *.exr, dir plates\*.exr): the files it matches there, by name (as
    // for's); a variable's value is quoted, so never one (SME review 2026-10-27 S1)
    // loop: NOT-WORTH — the line's few arguments
    const typed = p.positionals.find((x) => x.arg.id === "folder");
    // (a folder whose real name has [ or * is itself)
    // loop: NOT-WORTH — one async stat, only for a path with * ? or [
    const unquoted = folder !== undefined && typed !== undefined && !p.words[typed.word].quoted && /[*?[]/.test(dir) && !(await this.d.fs.stat(dir).catch(() => null));
    const glob = unquoted && /[*?[]/.test(a.basename(dir)) ? a.basename(dir) : null;
    if (unquoted && /[*?[]/.test(a.dirname(dir))) return this.finish(b, "refused", `${folder}: a pattern goes in the file's name only (plates/*.exr), not in its folders.`);
    if (glob) dir = a.dirname(dir);
    // a frame pattern (dir plates/plate.####.exr): that one sequence, in its folder
    const pat = folder !== undefined && !glob ? await this.patternAt(dir) : null;
    if (pat && !pat.seq) return this.finish(b, "failed", noFrames(pat, this.opts));
    if (pat) dir = pat.dir;
    let names: Dirent[];
    try {
      // loop: NOT-WORTH — one async readdir per dir / ls
      names = await this.d.fs.readdir(dir);
    } catch (e) {
      // error: SHOWN — the block says why
      return this.finish(b, "failed", `Can't list ${dir}: ${fsErrorText(e, dir)}. dir alone lists the current folder; Tab completes a name.`);
    }
    // dot files only with -a (ls's rule; dir /a)
    const all = has("all");
    // a pattern's own names: the others are left out by the pattern, not hidden (Marcy's screenshots 2026-10-27)
    const only = pat?.seq ? new Set(pat.seq.names) : null;
    // loop: NOT-WORTH — one folder's names, per dir / ls
    const matching = only ? names.filter((n) => only.has(n.name)) : names;
    const unmatched = names.length - matching.length;
    // loop: NOT-WORTH — as above
    names = all || glob?.startsWith(".") ? matching : matching.filter((n) => !n.name.startsWith("."));
    // dot files -a would show (never for a file-name pattern: ls -a *.exr leaves them out too)
    const hidden = glob ? 0 : matching.length - names.length;
    if (glob) {
      const re = globRegExp(glob, this.d.paths.platform === "win32" || this.d.paths.platform === "darwin");
      // loop: NOT-WORTH — as above
      names = names.filter((n) => re.test(n.name) && (glob.startsWith(".") || !n.name.startsWith(".")));
      if (!names.length) return this.finish(b, "failed", `No file matches ${folder} (dir lists the folder; Tab completes a name).`);
    }
    // loop: NOT-WORTH — sorts one folder's names, per dir / ls
    names.sort((x, y) => naturalCompare(x.name, y.name));
    // a sequence is one row (lsseq: sh010_plate.####.exr  1001-1100, its gaps), unless -f asks for the frames
    // loop: NOT-WORTH — one folder's names
    const every = names.map((n) => n.name);
    // loop: NOT-WORTH — as above
    const fileNames = names.filter((n) => !n.isDirectory()).map((n) => n.name);
    const grouped = has("frames") ? { sequences: [], singles: every } : pat?.seq ? { sequences: [pat.seq], singles: [] } : groupSequences(fileNames);
    // loop: NOT-WORTH — as above
    const inSequence = new Set(grouped.sequences.flatMap((q) => q.names));
    // loop: NOT-WORTH — one folder's names
    const rows = [...grouped.sequences.map((q) => ({ name: q.pattern, seq: q })), ...names.filter((n) => !inSequence.has(n.name)).map((n) => ({ name: n.name, seq: null, dirent: n }))];
    // loop: NOT-WORTH — sorts the rows, per dir / ls
    rows.sort((x, y) => naturalCompare(x.name, y.name));
    let entries: ConsoleEntry[] = [];
    // a sequence's size is its frames' (each one stat'ed, at most DIR_STATS in all): over that, it says "?"
    let stats = DIR_STATS;
    let unread = 0;
    // loop: NOT-WORTH — one async stat per listed entry (and per frame, at most DIR_STATS), at most LIST_MAX rows, per dir / ls
    for (const r of rows.slice(0, LIST_MAX)) {
      if (r.seq) {
        let bytes: number | null = 0;
        let modified = 0;
        // loop: NOT-WORTH — as above
        for (const n of r.seq.names) {
          const st = stats-- > 0 ? await this.d.fs.stat(a.join(dir, n)).catch(() => null) : null;
          if (!st) bytes = null;
          else if (bytes !== null) bytes += st.size;
          modified = Math.max(modified, st?.mtimeMs ?? 0);
        }
        if (bytes === null) unread += r.seq.count;
        entries.push({ name: r.name, folder: false, bytes, modified: modified || null, sequence: { range: r.seq.range, count: r.seq.count, missing: r.seq.missing } });
        continue;
      }
      const st = await this.d.fs.stat(a.join(dir, r.name)).catch(() => null);
      entries.push({ name: r.name, folder: st?.isDirectory() ?? r.dirent!.isDirectory(), bytes: st && !st.isDirectory() ? st.size : null, modified: st?.mtimeMs ?? null, sequence: null });
    }
    // newest / largest first (a folder counts as size 0), ties by name; -r reverses
    const key = (e: ConsoleEntry) => (by === "time" ? (e.modified ?? 0) : (e.bytes ?? 0));
    // loop: NOT-WORTH — sorts ≤ LIST_MAX rows, per dir / ls
    if (by !== "name") entries.sort((x, y) => key(y) - key(x) || naturalCompare(x.name, y.name));
    if (reverse) entries = entries.reverse();
    b.entries = entries;
    // the summary's folder: shown shortened by the page
    b.paths = [dir];
    // loop: NOT-WORTH — the listed entries
    const files = entries.filter((e) => !e.folder);
    // loop: NOT-WORTH — as above
    const fileCount = files.reduce((n, e) => n + (e.sequence?.count ?? 1), 0);
    // loop: NOT-WORTH — as above
    const bytes = files.reduce((n, e) => n + (e.bytes ?? 0), 0);
    // loop: NOT-WORTH — the listed files
    const seqs = files.filter((e) => e.sequence);
    // loop: NOT-WORTH — the sequences listed
    const framed = seqs.reduce((n, e) => n + e.sequence!.count, 0);
    const more = rows.length - entries.length;
    const summary =
      `${dir}: ${fileCount} files (${fileSizeText(bytes)}${unread ? `; the sizes of ${unread} frames not read` : ""})` +
      `${seqs.length ? `, ${framed} of them in ${seqs.length} sequence${seqs.length === 1 ? "" : "s"} (dir -f lists the frames)` : ""}` +
      `, ${entries.length - files.length} folders${more > 0 ? `; ${more} more not listed` : ""}${hidden > 0 ? `; ${hidden} hidden (dir -a shows them)` : ""}` +
      `${unmatched > 0 ? `; ${unmatched} other${unmatched === 1 ? "" : "s"} not matching the pattern` : ""}`;
    if (has("names")) {
      // names only (ls -1, dir /w /b): one per line, folders with a separator
      b.entries = null;
      // loop: NOT-WORTH — ≤ LIST_MAX names, per dir -1
      return this.finish(b, "done", ...entries.map((e) => e.name + (e.folder ? a.sep : "")));
    }
    return this.finish(b, "done", summary);
  }

  /**
   * doctor: every check in one go, one row each (✓ ⚠ ✗) with the fix for a problem. The card, ONNX Runtime and the models
   * come from `corridorkey info --json` (it loads the runtime and asks the driver; it never keys, so it takes no GPU slot);
   * ffmpeg and TensorRT from the app's own checks; each write folder: there, writable, its disk's free space.
   */
  private async doctor(b: ConsoleBlock, json: boolean): Promise<ConsoleBlock> {
    const rows: DoctorRow[] = [];
    const bin = this.d.cli();
    if (!bin)
      rows.push({
        check: "corridorkey",
        status: "fail",
        detail: "the command line isn't part of this copy of the app",
        fix: "App: install CorridorKey again (corridorkey ships next to its engine, in resources/engine)",
      });
    else {
      rows.push({ check: "corridorkey", status: "ok", detail: bin, fix: null, path: bin });
      rows.push(...infoRows(await this.cliInfo(bin)));
    }
    const app = this.d.doctor();
    rows.push(...app.rows);
    // loop: NOT-WORTH — a few folders, one async stat, access and statfs each
    for (const f of app.folders) rows.push(await this.folderRow(f.label, f.path));
    // loop: NOT-WORTH — the few rows
    const failed = rows.some((r) => r.status === "fail");
    b.exitCode = failed ? 1 : 0;
    // the rows are output (a ✓ row is never shown as an error), whatever the end
    const print = (lines: string[]) => {
      // loop: NOT-WORTH — the few rows' lines
      for (const l of lines) this.note(b, "out", l);
      return this.finish(b, failed ? "failed" : "done");
    };
    if (json) return print(JSON.stringify(rows, null, 2).split("\n"));
    // the page draws the rows as a table (OutputBlock); the block's text is their count
    b.doctor = rows;
    // loop: NOT-WORTH — the few rows
    const count = (s: DoctorRow["status"]) => rows.filter((r) => r.status === s).length;
    const [warn, fail] = [count("warn"), count("fail")];
    return print([`${rows.length} checks: ${rows.length - warn - fail} ok${warn ? `, ${warn} warning${warn === 1 ? "" : "s"}` : ""}${fail ? `, ${fail} problem${fail === 1 ? "" : "s"}` : ""}`]);
  }

  /** `corridorkey info --json`: its JSON, or what went wrong (its error line, without the exit code it prints). */
  private cliInfo(bin: string): Promise<{ info: Record<string, unknown> } | { error: string }> {
    return new Promise((resolve) => {
      const child = this.spawnFn(bin, ["info", "--json"], { cwd: this.cwd, env: this.d.cliEnv(), shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let out = "";
      let err = "";
      child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
      // loop: NOT-WORTH — one wait per doctor [bounded: INFO_TIMEOUT_MS, then it is killed]
      const timer = setTimeout(() => child.kill(), INFO_TIMEOUT_MS);
      const end = (code: number | null, e?: Error) => {
        clearTimeout(timer);
        // loop: NOT-WORTH — info's few stderr lines
        const last = err.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
        if (e) return resolve({ error: `corridorkey couldn't start: ${e.message}` });
        if (code !== 0) return resolve({ error: last.replace(/^ERROR: /, "").replace(/ \(exit \d+, [^)]*\)$/, "") || `corridorkey info ended with ${code === null ? "a signal" : `exit ${code}`}` });
        try {
          resolve({ info: JSON.parse(out) as Record<string, unknown> });
        } catch {
          // error: SHOWN — the row says it
          resolve({ error: "corridorkey info printed no JSON" });
        }
      };
      child.on("error", (e) => end(null, e));
      child.on("close", (code) => end(code));
    });
  }

  /** A folder the Console writes to: there, writable, and its disk's free space (✗ under 2 GiB, ⚠ under 20 GiB). */
  private async folderRow(label: string, path: string): Promise<DoctorRow> {
    // loop: NOT-WORTH — one async stat per folder
    const st = await this.d.fs.stat(path).catch(() => null);
    if (!st)
      return {
        check: label,
        status: "warn",
        detail: `${path} isn't there yet (the first job or command that writes there makes it)`,
        fix: "App settings: choose another folder if this one was on a drive that is gone",
        path,
      };
    if (!st.isDirectory()) return { check: label, status: "fail", detail: `${path} is a file, not a folder`, fix: "App settings: choose a folder", path };
    if (!(await this.d.fs.writable(path)))
      return { check: label, status: "fail", detail: `${path} isn't writable`, fix: "App settings: choose a folder you can write to (or fix its permissions)", path };
    const free = await this.d.fs.freeBytes(path).catch(() => null);
    const detail = `${path} · writable · ${free === null ? "free space unknown" : `${fileSizeText(free)} free`}`;
    if (free !== null && free < DISK_LOW)
      return { check: label, status: free < DISK_FULL ? "fail" : "warn", detail, fix: "Free space on that disk, or App settings: choose a folder on another disk", path };
    return { check: label, status: "ok", detail, fix: null, path };
  }

  /**
   * farm export <format> [clips…|--queue] -o <folder>: the queued clips as farm jobs (farm.ts), written into a folder the
   * Console may write to; files already there only with sudo … --overwrite (the same elevation as render's).
   */
  private async farm(b: ConsoleBlock, p: Parsed, inScript: boolean): Promise<ConsoleBlock> {
    const a = this.d.paths.platform === "win32" ? win32 : posix;
    // loop: NOT-WORTH — the line's few arguments
    const pos = (id: string) => p.positionals.filter((x) => x.arg.id === id).map((x) => x.value);
    // loop: NOT-WORTH — as above
    const out = p.options.find((o) => o.arg.id === "output")?.value;
    // loop: NOT-WORTH — as above
    const all = p.options.some((o) => o.arg.id === "queue");
    const format = pos("format")[0] as FarmFormat;
    const clips = pos("clips");
    if (!out) return this.finish(b, "refused", `farm export needs -o <folder>: where the job files go (farm export ${format} --queue -o ~/farm).`);
    if (all && clips.length) return this.finish(b, "refused", "Name clips or give --queue, not both.");
    if (!all && !clips.length) return this.finish(b, "refused", `Which clips? Name clips in the queue, or --queue for all of them (farm export ${format} --queue -o ${quoteArg(out, this.opts)}).`);
    const queued = this.d.jobs();
    if (!queued.length) return this.finish(b, "refused", "The queue is empty: farm export writes the queue's clips with their settings (add clips on the Queue page).");
    let jobs: QueueJob[] = [...queued];
    if (!all) {
      jobs = [];
      // loop: NOT-WORTH — the clips named, each looked up in the queue
      for (const c of clips) {
        const abs = a.resolve(this.cwd, expandHome(c, this.d.paths));
        // loop: NOT-WORTH — the queue's jobs
        const j = queued.find((q) => q.clip.path === abs || q.clip.name === c);
        if (!j) return this.finish(b, "refused", `${c} isn't in the queue: add it on the Queue page first (its settings come from there), or farm export ${format} --queue.`);
        if (!jobs.includes(j)) jobs.push(j);
      }
    }
    const w = await checkWrite(out, this.cwd, this.d.writeRoots(), this.d.paths);
    if (!w.ok) return this.finish(b, "refused", `-o: ${w.reason}`);
    const farmJobs: FarmJob[] = [];
    // loop: NOT-WORTH — the exported jobs, one async range read each
    for (const j of jobs) {
      const range = await this.shotRange(j);
      if (range && "error" in range) return this.finish(b, "refused", range.error);
      farmJobs.push({ ...j, name: clipName(j.clip.path, this.d.paths.platform), range: range?.range ?? null, pad: range?.pad });
    }
    const env = this.d.cliEnv();
    // loop: NOT-WORTH — the line's few options
    const opt = (id: string) => p.options.find((o) => o.arg.id === id)?.value ?? null;
    const platform = opt("platform") ?? (this.d.paths.platform === "win32" ? "windows" : this.d.paths.platform === "darwin" ? "darwin" : "linux");
    const exp = farmExport(format, farmJobs, {
      models: opt("models") ?? env.CK_ENGINE_MODELS ?? null,
      ort: opt("ort") ?? env.CK_ENGINE_ORT ?? null,
      local: { models: opt("models") === null, ort: opt("ort") === null },
      deadline: { batch: a.basename(w.path), pool: opt("pool"), group: opt("group"), priority: Number(opt("priority") ?? 50) },
      platform: platform as "linux" | "windows" | "darwin",
    });
    if (exp.error) return this.finish(b, "refused", exp.error);
    // loop: NOT-WORTH — the files to write
    const paths = exp.files.map((f) => a.join(w.path, ...f.path.split("/")));
    const there: string[] = [];
    // each file it writes: inside the write scope once resolved (a linked folder leads out), and never a link itself (a
    // dangling one reads as "not there"): senior review 2026-10-27 M2
    // loop: NOT-WORTH — the export's few files, one async realpath and lstat each
    for (const f of paths) {
      const c = await checkWrite(f, this.cwd, this.d.writeRoots(), this.d.paths);
      if (!c.ok) return this.finish(b, "refused", `${f}: ${c.reason}`);
      const l = await this.d.fs.lstat(f).catch(() => null);
      if (l?.isSymbolicLink()) return this.finish(b, "refused", `${f} is a link: farm export never writes through one (remove the link, or export into another folder).`);
      if (l) there.push(f);
    }
    // loop: NOT-WORTH — the line's options
    const overwrite = p.options.some((o) => o.arg.destructive);
    if (there.length && !overwrite)
      return this.finish(
        b,
        "refused",
        `${there.length} of its files are already there (${there[0]}${there.length > 1 ? ", …" : ""}): sudo ${b.line.trim().replace(/^sudo\s+/, "")} --overwrite replaces them.`,
      );
    // loop: NOT-WORTH — the line's few words
    const argv = ["farm", ...p.words.slice(p.sudo ? 2 : 1).map((x) => x.value)];
    const refusal = await this.elevate(b, p, argv.slice(1), argv, there, inScript, null);
    if (refusal) return refusal;
    if (b.elevated && !(await this.d.audit.append({ event: "run", argv, targets: there }))) {
      b.elevated = false;
      return this.finish(b, "refused", AUDIT_FAILED);
    }
    let failed: string | null = null;
    try {
      // loop: NOT-WORTH — the export's few files, one async write each
      for (const [i, f] of exp.files.entries()) {
        await this.d.fs.mkdir(a.dirname(paths[i]));
        await this.d.fs.writeFile(paths[i], f.text);
      }
    } catch (e) {
      // error: SHOWN — the block says which file and why
      failed = `Can't write the job files: ${fsErrorText(e, w.path)}.`;
    }
    // loop: NOT-WORTH — one async append per elevated export [bounded: a local file write]
    if (b.elevated) await this.d.audit.append({ event: "exit", argv, exit: failed ? 1 : 0 });
    if (failed) return this.finish(b, "failed", failed);
    if (!exp.files.length) return this.finish(b, "failed", ...exp.notes);
    return this.finish(b, "done", `Wrote ${exp.files.length} files in ${w.path}:`, ...fileList(exp.files, this.opts.windows), ...exp.notes);
  }

  /**
   * A queued clip's first and last frame as corridorkey numbers them (ck-core clip.rs FrameNumbers): a video from 1001,
   * a frame folder by all of its files (sequences.ts folderRange; a folder of several sequences is an error). Null: not
   * known (a video not probed, a folder that can't be read).
   */
  private async shotRange(j: QueueJob): Promise<{ range: [number, number]; pad?: number } | null | { error: string }> {
    if (j.clip.kind === "video") return j.clip.frames ? { range: [1001, 1000 + j.clip.frames] } : null;
    // loop: NOT-WORTH — one async readdir per frame folder exported
    const names = await this.d.fs.readdir(j.clip.path).catch(() => null);
    if (!names) return null;
    // loop: NOT-WORTH — the folder's names
    const r = folderRange(names.filter((n) => !n.isDirectory() && isFrameFile(n.name)).map((n) => n.name));
    return "error" in r ? { error: `${j.clip.path}: ${r.error}` } : r;
  }

  /** A path whose file name is a frame pattern (####, %04d, $F4, @@@@) and that isn't a file or folder itself: its folder. */
  private async patternFolder(path: string): Promise<string | null> {
    const a = this.d.paths.platform === "win32" ? win32 : posix;
    const abs = a.resolve(this.cwd, expandHome(path, this.d.paths));
    if (!frameToken(a.basename(abs))) return null;
    // loop: NOT-WORTH — one async stat per path given
    return (await this.d.fs.stat(abs).catch(() => null)) ? null : a.dirname(abs);
  }

  /** As patternFolder, with the sequence the pattern names there (null: no frame of it). */
  private async patternAt(path: string): Promise<{ dir: string; pattern: string; seq: Sequence | null } | null> {
    const dir = await this.patternFolder(path);
    if (dir === null) return null;
    // loop: NOT-WORTH — one async readdir per pattern given
    const names = await this.d.fs.readdir(dir).catch(() => [] as Dirent[]);
    const pattern = (this.d.paths.platform === "win32" ? win32 : posix).basename(path);
    // loop: NOT-WORTH — one folder's names
    const files = names.filter((n) => !n.isDirectory()).map((n) => n.name);
    return { dir, pattern, seq: sequenceOf(pattern, files) };
  }

  /** history [N|term]: numbered (stable numbers), when, how it ended (✓, ✗ and the exit code), the line, its folder. */
  private async historyBlock(b: ConsoleBlock, audit: boolean, which: string | undefined): Promise<ConsoleBlock> {
    if (!audit) {
      const count = which !== undefined && /^\d+$/.test(which) ? Math.max(1, Math.min(HISTORY_SHOWN_MAX, Number(which))) : null;
      // the last N (default 50), or every line (and folder) with the term, oldest first
      const list = which === undefined || count !== null ? this.d.history.last(count ?? 50) : this.d.history.entries(which, HISTORY_SHOWN_MAX).reverse();
      // loop: NOT-WORTH — ≤ HISTORY_SHOWN_MAX lines, once per history
      const width = Math.max(4, ...list.map((e) => String(e.n).length));
      const ended = (e: ConsoleHistoryEntry) => (e.state === null ? " " : e.state === "done" ? "✓" : `✗${e.exit !== null ? ` ${e.exit}` : ""}`);
      // loop: NOT-WORTH — as above
      const lines = list.map((e) => `${String(e.n).padStart(width)}  ${localTime(e.time)}  ${ended(e).padEnd(5)}${e.line}${e.cwd ? `   [${e.cwd}]` : ""}`);
      return this.finish(b, "done", ...(lines.length ? lines : [which === undefined ? "No history yet." : `No line contains ${which}.`]));
    }
    const entries = await this.d.audit.tail(50);
    // loop: NOT-WORTH — ≤ 50 entries
    const text = entries.map((e) =>
      [e.time, e.event, e.argv ? e.argv.join(" ") : "", e.exit !== undefined ? `exit ${e.exit}` : "", e.reason ?? "", e.targets?.length ? `targets: ${e.targets.join(", ")}` : ""]
        .filter(Boolean)
        .join("  "),
    );
    return this.finish(b, "done", ...(text.length ? text : ["Nothing elevated yet."]));
  }

  /** A path a file built-in was given: a bookmark's folder, ~, relative to the Console's folder; null: no such bookmark. */
  private file(given: string): string | null {
    const m = this.at(given);
    return m === null ? null : (this.d.paths.platform === "win32" ? win32 : posix).resolve(this.cwd, expandHome(m, this.d.paths));
  }

  /** A text file's size, or why it can't be read as one (not there, a folder, binary). */
  private async textFile(given: string): Promise<{ path: string; size: number } | { error: string }> {
    const path = this.file(given);
    if (path === null) return { error: noBookmark(given) };
    // loop: NOT-WORTH — one async stat per file given
    const st = await this.d.fs.stat(path).catch((e: unknown) => e as Error);
    if (st instanceof Error) return { error: `Can't read ${given}: ${fsErrorText(st, path)}. dir lists the files here; Tab completes a name.` };
    if (!st.isFile()) return { error: `${given} isn't a file${st.isDirectory() ? " (it is a folder: dir lists it)" : ""}.` };
    return { path, size: st.size };
  }

  /** cat FILE…: each text file's lines (its first LINES_MAX; a binary file refused); several: each under its name. */
  private async cat(b: ConsoleBlock, files: string[]): Promise<ConsoleBlock> {
    // loop: NOT-WORTH — the files named, one bounded read each
    for (const f of files) {
      const t = await this.textFile(f);
      if ("error" in t) return this.finish(b, "failed", t.error);
      const buf = await this.d.fs.readRange(t.path, 0, Math.min(t.size, TEXT_MAX));
      if (isBinary(buf)) return this.finish(b, "failed", `${f} isn't text (cat shows text files only; open ${quoteArg(f, this.opts)} shows it in the file manager).`);
      const lines = textLines(buf, false, t.size > TEXT_MAX);
      if (files.length > 1) this.note(b, "info", `==> ${f} <==`);
      // loop: NOT-WORTH — ≤ LINES_MAX lines
      for (const l of lines.slice(0, LINES_MAX)) this.note(b, "out", l);
      if (lines.length > LINES_MAX || t.size > TEXT_MAX) this.note(b, "info", `… cat shows a file's first ${LINES_MAX} lines (and 1 MiB): head -n and tail -n show other parts.`);
    }
    return this.finish(b, "done");
  }

  /** head / tail [-n N] FILE: a text file's first or last N lines (read from its start or its end, at most TEXT_MAX). */
  private async headTail(b: ConsoleBlock, f: string, tail: boolean, n: number): Promise<ConsoleBlock> {
    n = Math.max(1, Math.min(LINES_MAX, n));
    const t = await this.textFile(f);
    if ("error" in t) return this.finish(b, "failed", t.error);
    const from = tail ? Math.max(0, t.size - TEXT_MAX) : 0;
    const buf = await this.d.fs.readRange(t.path, from, Math.min(t.size, TEXT_MAX));
    if (isBinary(tail ? buf.subarray(-8192) : buf)) return this.finish(b, "failed", `${f} isn't text (${tail ? "tail" : "head"} shows text files only).`);
    const lines = textLines(buf, from > 0, !tail && t.size > TEXT_MAX);
    return this.finish(b, "done", ...(tail ? lines.slice(-n) : lines.slice(0, n)));
  }

  /** wc FILE…: lines, words and bytes (each file read in TEXT_MAX chunks, at most WC_MAX); several: a total. */
  private async wc(b: ConsoleBlock, files: string[], stop: () => boolean): Promise<ConsoleBlock> {
    const rows: [number, number, number, string][] = [];
    // loop: NOT-WORTH — the files named
    for (const f of files) {
      const t = await this.textFile(f);
      if ("error" in t) return this.finish(b, "failed", t.error);
      if (t.size > WC_MAX) return this.finish(b, "failed", `${f} is larger than ${fileSizeText(WC_MAX)}: wc counts text files up to that.`);
      const c = new TextCount();
      // loop: SERIAL-REQUIRED — one file's chunks in order (words span chunks) [bounded: WC_MAX / TEXT_MAX reads; Ctrl+C between them]
      for (let at = 0; at < t.size; at += TEXT_MAX) {
        c.add(await this.d.fs.readRange(t.path, at, Math.min(TEXT_MAX, t.size - at)));
        if (stop()) return this.finish(b, "cancelled");
      }
      rows.push([c.lines, c.words, c.bytes, f]);
    }
    // loop: NOT-WORTH — a few rows
    if (rows.length > 1) rows.push([rows.reduce((s, r) => s + r[0], 0), rows.reduce((s, r) => s + r[1], 0), rows.reduce((s, r) => s + r[2], 0), "total"]);
    // loop: NOT-WORTH — as above
    const w = Math.max(5, ...rows.flatMap((r) => [String(r[0]).length, String(r[1]).length, String(r[2]).length]));
    // loop: NOT-WORTH — as above
    return this.finish(
      b,
      "done",
      ["lines", "words", "bytes", ""]
        .map((h, i) => (i < 3 ? h.padStart(w) : h))
        .join("  ")
        .trimEnd(),
      ...rows.map((r) => `${String(r[0]).padStart(w)}  ${String(r[1]).padStart(w)}  ${String(r[2]).padStart(w)}  ${r[3]}`),
    );
  }

  /** du [FOLDER…]: each folder inside it with its size, then its total (files counted once; links not followed). */
  private async du(b: ConsoleBlock, folders: string[], stop: () => boolean): Promise<ConsoleBlock> {
    const a = this.d.paths.platform === "win32" ? win32 : posix;
    const budget = { left: DU_ENTRIES, stop };
    // loop: NOT-WORTH — the folders named (one by default)
    for (const f of folders.length ? folders : ["."]) {
      const dir = this.file(f);
      if (dir === null) return this.finish(b, "failed", noBookmark(f));
      let names: Dirent[];
      try {
        // loop: NOT-WORTH — one async readdir per folder named
        names = await this.d.fs.readdir(dir);
      } catch (e) {
        // error: SHOWN — the block says why
        return this.finish(b, "failed", `Can't size ${f}: ${fsErrorText(e, dir)}.`);
      }
      if (stop()) return this.finish(b, "cancelled");
      let total = 0;
      const rows: [number, string][] = [];
      // loop: NOT-WORTH — one folder's entries; each folder walked once [bounded: DU_ENTRIES entries in all; Ctrl+C at each]
      for (const n of names.sort((x, y) => naturalCompare(x.name, y.name))) {
        if (stop()) return this.finish(b, "cancelled");
        if (n.isDirectory()) {
          const s = await this.walk(a.join(dir, n.name), () => true, true, budget);
          rows.push([s.bytes, n.name + a.sep]);
          total += s.bytes;
        } else if (!n.isSymbolicLink()) total += (await this.d.fs.stat(a.join(dir, n.name)).catch(() => null))?.size ?? 0;
      }
      if (stop()) return this.finish(b, "cancelled");
      const cut = budget.left <= 0 ? "≥ " : "";
      // loop: NOT-WORTH — the folder's folders
      for (const [bytes, name] of rows) this.note(b, "out", `${(cut + fileSizeText(bytes)).padStart(12)}  ${name}`);
      this.note(b, "out", `${(cut + fileSizeText(total)).padStart(12)}  ${dir === this.cwd ? "." : f} (total)`);
      if (cut) this.note(b, "info", `… stopped counting after ${DU_ENTRIES.toLocaleString("en-US")} entries: the sizes are at least these.`);
    }
    return this.finish(b, "done");
  }

  /** tree [FOLDER] [-L N] [-a]: folders inside folders to depth N (default 2), sequences as one row, at most TREE_ROWS. */
  private async tree(b: ConsoleBlock, folder: string | undefined, depth: number, all: boolean, stop: () => boolean): Promise<ConsoleBlock> {
    const a = this.d.paths.platform === "win32" ? win32 : posix;
    depth = Math.max(1, Math.min(TREE_DEPTH_MAX, depth));
    const dir = this.file(folder ?? ".");
    if (dir === null) return this.finish(b, "failed", noBookmark(folder));
    let rows = 0;
    let folders = 0;
    let files = 0;
    const read = async (path: string, name: string, level: number): Promise<TreeNode | { error: unknown }> => {
      let names: Dirent[];
      try {
        // loop: NOT-WORTH — one async readdir per folder shown [bounded: TREE_ROWS rows]
        names = await this.d.fs.readdir(path);
      } catch (e) {
        // error: SHOWN — the root's is the block's; a folder inside says so on its row
        return { error: e };
      }
      // loop: NOT-WORTH — one folder's names
      const shown = names.filter((n) => all || !n.name.startsWith("."));
      // loop: NOT-WORTH — as above
      const subs = shown.filter((n) => n.isDirectory()).map((n) => n.name);
      // loop: NOT-WORTH — as above
      const grouped = groupSequences(shown.filter((n) => !n.isDirectory()).map((n) => n.name));
      const kids: TreeNode[] = [
        // loop: NOT-WORTH — the folder's sequences
        ...grouped.sequences.map((q) => ({ name: q.pattern, folder: false, note: `${q.range} · ${q.count} frames${q.missing ? ` · missing ${q.missing}` : ""}` })),
        // loop: NOT-WORTH — its other files
        ...grouped.singles.map((n) => ({ name: n, folder: false })),
        // loop: NOT-WORTH — its folders
        ...subs.map((n) => ({ name: n, folder: true })),
        // loop: NOT-WORTH — sorts one folder's rows
      ].sort((x, y) => naturalCompare(x.name, y.name));
      const node: TreeNode = { name, folder: true, children: [] };
      // loop: NOT-WORTH — one folder's rows, the folders read in turn [bounded: TREE_ROWS rows in all]
      for (const [i, k] of kids.entries()) {
        if (stop()) break;
        if (rows >= TREE_ROWS) {
          node.more = kids.length - i;
          break;
        }
        rows++;
        if (!k.folder) {
          files++;
          node.children!.push(k);
          continue;
        }
        folders++;
        if (level >= depth) {
          node.children!.push(k);
          continue;
        }
        const sub = await read(a.join(path, k.name), k.name, level + 1);
        node.children!.push("error" in sub ? { ...k, note: "(can't be read)" } : sub);
      }
      return node;
    };
    const root = await read(dir, folder ?? ".", 1);
    if (stop()) return this.finish(b, "cancelled");
    if ("error" in root) return this.finish(b, "failed", `Can't list ${folder ?? "."}: ${fsErrorText(root.error, dir)}.`);
    b.nowrap = true;
    // loop: NOT-WORTH — ≤ TREE_ROWS lines
    for (const l of treeLines(root, a.sep)) this.note(b, "out", l);
    return this.finish(
      b,
      "done",
      `${folders} folder${folders === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"} or sequences${rows >= TREE_ROWS ? ` (the first ${TREE_ROWS} rows; tree -L 1 or a folder inside shows less)` : ""}`,
    );
  }

  /** run <file.ckcmd>: its commands through runLine (the same checks), in order, until one fails (--keep-going: on). */
  private async script(b: ConsoleBlock, file: string, nested: boolean, keepGoing: boolean): Promise<{ block: ConsoleBlock; done: Promise<ConsoleBlock> }> {
    const now = (x: ConsoleBlock) => ({ block: x, done: Promise.resolve(x) });
    if (nested) return now(this.finish(b, "refused", "A script can't run another script (nor can a line with ; && || for, if or time): run it on its own line."));
    if (this.job) return now(this.finish(b, "refused", `Busy with ${this.job.block.line} (one command at a time; Ctrl+C stops it).`));
    const a = this.d.paths.platform === "win32" ? win32 : posix;
    const path = a.resolve(this.cwd, expandHome(file, this.d.paths));
    // the slot is taken before the first await: a command typed while the file is read is refused, never overwritten
    const job: Job = { block: b, child: null, cancels: 0 };
    this.job = job;
    this.d.sessionChanged();
    let text: string;
    try {
      text = await this.d.fs.readFile(path, FILE_MAX);
    } catch (e) {
      this.job = null;
      this.d.sessionChanged();
      // error: SHOWN — the block says why
      return now(this.finish(b, "failed", `Can't read the script: ${fsErrorText(e, path)}. dir lists the files here; Tab completes a name.`));
    }
    return this.runText(b, job, text, a.basename(path), keepGoing);
  }

  /**
   * Lines pasted into the input (more than one), run as a script once the page's offer is taken: the same path as
   * `run`, so the same checks, the same stop at the first that fails, the same one confirmation up front.
   */
  async runLines(lines: readonly string[]): Promise<ConsoleBlock> {
    const b = this.block(lines.join("\n"), null);
    if (this.job) return this.finish(b, "refused", `Busy with ${this.job.block.line} (one command at a time; Ctrl+C stops it).`);
    // each pasted line runs as a typed one: a quote it leaves open would run into the next (P4 senior review N3)
    // loop: NOT-WORTH — the pasted lines (≤ the IPC's cap), once per paste
    const open = lines.findIndex((l) => leavesQuoteOpen(l, this.opts));
    if (open >= 0) return this.finish(b, "refused", `pasted:${open + 1}: a quote isn't closed on this line (each pasted line runs as typed); nothing ran.`);
    const job: Job = { block: b, child: null, cancels: 0 };
    this.job = job;
    this.d.sessionChanged();
    return (await this.runText(b, job, lines.join("\n"), "pasted", false)).block;
  }

  /** A script's text: read as a program (script.ts), then run as one; a mistake in it runs nothing. */
  private runText(b: ConsoleBlock, job: Job, text: string, name: string, keepGoing: boolean): Promise<{ block: ConsoleBlock; done: Promise<ConsoleBlock> }> {
    const prog = parseProgram(text, this.opts);
    if ("error" in prog) {
      this.job = null;
      this.d.sessionChanged();
      // loop: NOT-WORTH — counts new lines before the mistake, once
      const line = text.slice(0, prog.error.start).split("\n").length;
      const x = this.finish(b, "refused", `${name}:${line}: ${prog.error.message}; nothing ran.`);
      return Promise.resolve({ block: x, done: Promise.resolve(x) });
    }
    return this.program(b, prog.list, name, keepGoing, job);
  }

  /**
   * A program (a script, or a typed line with ; && || for if time) as one job: the slot taken for all of it. Before any
   * command runs: a command that replaces files must say `sudo` (else nothing runs), and all such commands are listed in
   * ONE confirmation (cancelled: nothing runs). A program never uses or extends the session's elevation, and its
   * confirmation never elevates the session. A script (`name`) stops at the first command that fails (bash's set -e:
   * not one on the left of && or ||, nor an if's condition) unless `keepGoing`; a typed line goes on, as bash does.
   */
  private async program(b: ConsoleBlock, list: List, name: string | null, keepGoing: boolean, held?: Job): Promise<{ block: ConsoleBlock; done: Promise<ConsoleBlock> }> {
    const now = (x: ConsoleBlock) => ({ block: x, done: Promise.resolve(x) });
    if (!held && this.job) return now(this.finish(b, "refused", `Busy with ${this.job.block.line} (one command at a time; Ctrl+C stops it).`));
    const job: Job = held ?? { block: b, child: null, cancels: 0 };
    this.job = job;
    this.d.sessionChanged();
    const release = (x: ConsoleBlock) => {
      this.job = null;
      this.d.sessionChanged();
      return now(x);
    };
    const where = (n: number) => (name === null ? "" : `${name}:${n}  `);
    // loop: NOT-WORTH — a program's commands, parsed once before it runs
    const destructive = commands(list)
      .map((c) => ({ node: c, text: c.text, line: c.line, p: parse(c.text, this.d.registry, this.opts) }))
      // loop: NOT-WORTH — one command's options
      .filter((x) => x.p.options.some((o) => o.arg.destructive));
    // loop: NOT-WORTH — as above
    const bare = destructive.find((x) => !x.p.sudo);
    if (bare)
      return release(
        this.finish(
          b,
          "refused",
          `${name === null ? "" : `${name}:${bare.line} `}replaces files: ${name === null ? "a line with ; && || for or if" : "a script"} says so with sudo (sudo ${bare.text}); nothing ran.`,
        ),
      );
    if (destructive.length) {
      const ask = await this.scriptAsk(list, destructive);
      job.confirmed = ask.confirmed;
      // loop: NOT-WORTH — as above
      const listed = destructive.map((x, i) => visible(`${where(x.line)}${x.text}${ask.shown[i]}`));
      const label = name ?? "the line typed";
      const ok = await this.d.confirmScript({ script: visible(label), lines: listed, targets: ask.targets, movesFolder: ask.movesFolder });
      const logged = await this.d.audit.append({
        event: ok ? "granted" : "refused",
        argv: ["run", label],
        // loop: NOT-WORTH — the targets shown
        targets: ask.targets.map((t) => t.path),
        reason: `the script's ${listed.length} line(s) that replace files: ${listed.join(" | ")}`,
      });
      if (!ok) return release(this.finish(b, "refused", "Not run: the confirmation was cancelled (nothing ran)."));
      if (!logged) return release(this.finish(b, "refused", AUDIT_FAILED));
      job.scriptGrant = true;
      b.elevated = true;
    }
    const ctx: RunCtx = { b, job, name, keepGoing, failed: null, stopped: false, failures: 0, scope: new Map(), commands: 0 };
    const done = (async () => {
      let status = 1;
      try {
        status = await this.runList(list, ctx);
      } catch (e) {
        // error: SHOWN — anything the runner itself throws ends the program failed, in words; the slot is freed below
        this.note(b, "err", `stopped: ${String((e as Error)?.message ?? e)}`);
        ctx.stopped = true;
        ctx.failed = 1;
      } finally {
        // the one slot, freed however the program ended (senior review 2026-10-27 M4: a throw kept it until restart)
        this.job = null;
        this.d.sessionChanged();
      }
      if (job.cancels > 0) return this.finish(b, "cancelled");
      if (ctx.failures) this.note(b, "err", `${ctx.failures} command${ctx.failures === 1 ? "" : "s"} failed (--keep-going went on)`);
      if (ctx.stopped || ctx.failures || status !== 0) {
        b.exitCode = ctx.failed !== null && (ctx.stopped || ctx.failures) ? ctx.failed : status;
        return this.finish(b, "failed");
      }
      return this.finish(b, "done");
    })();
    return { block: b, done };
  }

  /**
   * What a program's one confirmation shows for its lines that replace files (S2): each line's `${…}` filled in with
   * the values it will get, where they are known before it runs (a variable no line of the program sets, unsets or
   * loops over; `${home}`), else said; and the files the lines known now would replace in their written folders,
   * counted as a single command's dialog counts them (a relative folder only while the program doesn't change folder).
   */
  private async scriptAsk(
    list: List,
    lines: { node: CmdNode; p: Parsed }[],
  ): Promise<{ shown: string[]; confirmed: Map<CmdNode, string>; targets: ElevationRequest["targets"]; movesFolder: boolean }> {
    const a = this.d.paths.platform === "win32" ? win32 : posix;
    // the names whose value changes while the program runs: its loops' and its set / unset's, and the Console's own
    // (but ${home})
    // loop: NOT-WORTH — five names
    const changing = new Set<string>(READ_ONLY.filter((n) => n !== "home"));
    let movesFolder = false;
    // loop: NOT-WORTH — the program's commands, parsed once before it runs
    for (const c of commands(list)) {
      const q = parse(c.text, this.d.registry, this.opts);
      const n = q.command?.name;
      if (n === "cd" || n === "pushd" || n === "popd" || n === "j") movesFolder = true;
      // loop: NOT-WORTH — one command's few words
      if (n === "set" || n === "unset") for (const w of q.positionals) changing.add(w.value.split("=")[0]);
    }
    const loops = (l: List): void =>
      // loop: NOT-WORTH — the program's nodes
      l.items.forEach(({ node: x }) => {
        if (x.kind === "for") {
          changing.add(x.name);
          loops(x.body);
        } else if (x.kind === "if") {
          // loop: NOT-WORTH — an if's three lists
          [x.cond, x.then, x.else].forEach((y) => y && loops(y));
        }
      });
    loops(list);
    const shown: string[] = [];
    const confirmed = new Map<CmdNode, string>();
    const paths: string[] = [];
    const targets: ElevationRequest["targets"] = [];
    // loop: NOT-WORTH — the program's few lines that replace files, one async realpath per written folder
    for (const { node } of lines) {
      const v = expandVars(node.text, (k) => (changing.has(k) ? undefined : this.lookup(k)), this.opts);
      if ("error" in v) {
        shown.push("   (its ${…} are filled in when it runs: the program's loop or set gives them)");
        continue;
      }
      shown.push(v.changed ? `   →  ${v.line}` : "");
      if (v.changed) confirmed.set(node, v.line);
      const q = parse(v.line, this.d.registry, this.opts);
      // loop: NOT-WORTH — the line's few options
      const written = q.options.filter((o) => o.arg.writes && o.value !== null && !(movesFolder && !a.isAbsolute(expandHome(o.value!, this.d.paths))));
      // loop: NOT-WORTH — one or two written folders
      for (const o of written) {
        const w = await checkWrite(o.value!, this.cwd, this.d.writeRoots(), this.d.paths);
        if (!w.ok || paths.includes(w.path)) continue;
        paths.push(w.path);
        // loop: NOT-WORTH — the line's few arguments
        const input = q.positionals.find((x) => x.arg.id === "clip")?.value ?? q.options.find((x) => x.arg.id === "input")?.value;
        targets.push(...(await this.measureTargets([w.path], q.command?.name === "render" && input ? clipName(input, this.d.paths.platform) : null)));
      }
    }
    return { shown, confirmed, targets, movesFolder };
  }

  /** Runs a list: each command after its operator says so (&&: the last ended 0, ||: it didn't); the last status. */
  private async runList(list: List, ctx: RunCtx, checked = ctx.name !== null): Promise<number> {
    let status = this.status;
    // loop: SERIAL-REQUIRED — a program's commands run one after another, each waiting for the last [bounded: PROGRAM_COMMANDS_MAX commands in all, nested loops included; a turn of the event loop before each]
    for (const [i, { op, node }] of list.items.entries()) {
      if (ctx.job.cancels > 0 || this.closing || ctx.stopped) break;
      if ((op === "&&" && status !== 0) || (op === "||" && status === 0)) continue;
      // the end of an && / || chain: a failure there stops a script (bash's set -e)
      const next = list.items[i + 1]?.op;
      const chainEnd = next !== "&&" && next !== "||";
      if (node.kind === "if") {
        // an if's condition never stops a script or counts as a failure: it is a question
        const c = await this.runList(node.cond, ctx, false);
        const branch = c === 0 ? node.then : node.else;
        status = branch && !ctx.stopped && ctx.job.cancels === 0 ? await this.runList(branch, ctx, checked) : 0;
        continue;
      }
      if (node.kind === "for") {
        const items = await this.forItems(node.items, ctx.scope, ctx.b);
        if ("error" in items) {
          this.note(ctx.b, "err", `${ctx.name === null ? "" : `${ctx.name}:${node.line}: `}for ${node.name}: ${items.error}`);
          status = 2;
          if (checked) this.fail(ctx, node.line, status);
          continue;
        }
        status = 0;
        const had = ctx.scope.get(node.name);
        // loop: SERIAL-REQUIRED — each item's body runs after the last [bounded: ITEMS_MAX items; PROGRAM_COMMANDS_MAX commands for the whole program]
        for (const v of items) {
          if (ctx.job.cancels > 0 || this.closing || ctx.stopped) break;
          ctx.scope.set(node.name, v);
          status = await this.runList(node.body, ctx, checked);
        }
        if (had === undefined) ctx.scope.delete(node.name);
        else ctx.scope.set(node.name, had);
        continue;
      }
      // one budget for the whole program: loops inside loops multiply their items (senior review 2026-10-27 M4)
      if (++ctx.commands > PROGRAM_COMMANDS_MAX) {
        this.note(ctx.b, "err", `stopped: more than ${PROGRAM_COMMANDS_MAX} commands in one program (a loop inside a loop multiplies them): name a smaller set`);
        ctx.stopped = true;
        ctx.failed = 1;
        break;
      }
      // a turn of the event loop before each command: Ctrl+C, the block pushes and the window get in between built-ins
      // that never wait on anything (a loop of echo would otherwise hold the main process until it ends)
      // loop: NOT-WORTH — one setImmediate per command [bounded: PROGRAM_COMMANDS_MAX commands]
      await new Promise((r) => setImmediate(r));
      if (ctx.job.cancels > 0 || this.closing) break;
      if (ctx.name !== null) this.note(ctx.b, "info", `${ctx.name}:${node.line}  ${node.time ? "time " : ""}${node.text}`);
      const v = this.expand(node.text, ctx.scope);
      const started = this.now();
      // a confirmed line runs only as the confirmation showed it filled in
      const shown = ctx.job.confirmed?.get(node);
      const changed = shown !== undefined && !("error" in v) && v.line !== shown;
      const r = "error" in v || changed ? null : await this.runLine(v.line, ctx.b.id, v.changed ? node.text : null);
      const end = r
        ? await r.done
        : this.finish(this.block(node.text, ctx.b.id), "refused", changed ? `Not run: its \${…} changed since the confirmation (it showed ${shown}).` : (v as { error: string }).error);
      status = statusOf(end);
      this.status = status;
      if (node.time) this.note(ctx.b, "out", timeLine(end, this.now() - started));
      if (status !== 0 && chainEnd && checked && end.state !== "cancelled") this.fail(ctx, node.line, status, end);
    }
    return status;
  }

  /** A command failed at the end of its chain: a script stops there (set -e), or --keep-going counts it and goes on. */
  private fail(ctx: RunCtx, line: number, status: number, end?: ConsoleBlock): void {
    if (ctx.keepGoing) {
      ctx.failures++;
      ctx.failed = status;
      return;
    }
    ctx.stopped = true;
    ctx.failed = status;
    this.note(ctx.b, "err", `stopped at line ${line}: ${end?.state ?? "failed"}${end?.exitCode !== null && end?.exitCode !== undefined ? ` (exit ${end.exitCode})` : ""}`);
  }

  /**
   * A for loop's words, filled in (vars.ts forWords): a word with * ? or [ typed in its file name is the files it
   * matches there, by name; a typed frame pattern (plate.####.exr) is its frames' files; anything else itself. Only
   * what was typed unquoted counts: a variable's value is never a pattern, but the pattern typed around it still is
   * (`${show}/*.exr`: SME review 2026-10-27 M3); `${list[@]}` is a value's words (S10). A pattern that matches nothing
   * is an error (zsh's rule: never the pattern itself).
   */
  private async forItems(items: string, scope: ReadonlyMap<string, string>, b: ConsoleBlock): Promise<string[] | { error: string }> {
    const fw = forWords(items, (name) => scope.get(name) ?? this.lookup(name), this.opts);
    if ("error" in fw) return fw;
    // loop: NOT-WORTH — a loop's few notes
    for (const n of fw.notes) this.note(b, "info", n);
    const a = this.d.paths.platform === "win32" ? win32 : posix;
    const out: string[] = [];
    const tooMany = `more than ${ITEMS_MAX} items: name a smaller set`;
    // loop: NOT-WORTH — the loop's words, one async readdir per pattern
    for (const w of fw.words) {
      const cut = Math.max(w.value.lastIndexOf("/"), this.opts.windows ? w.value.lastIndexOf("\\") : -1);
      const [dirPart, namePart] = [w.value.slice(0, cut + 1), w.value.slice(cut + 1)];
      const nameOn = w.active.slice(cut + 1);
      // the characters typed unquoted (a value's and a quoted one's are NUL here: never a pattern)
      // loop: NOT-WORTH — one word's characters
      const typed = (from: number, text: string) => [...text].map((c, i) => (w.active[from + i] ? c : "\0")).join("");
      const glob = /[*?[]/.test(typed(cut + 1, namePart));
      if (/[*?[]/.test(typed(0, dirPart))) return { error: `${w.value}: a pattern goes in the file's name only (plates/*.exr), not in its folders` };
      const token = frameToken(typed(cut + 1, namePart));
      if (token && frameToken(namePart)?.at !== token.at) return { error: `${w.value}: a variable's value has a frame token before the one typed; write the pattern without it` };
      const base = this.at(dirPart);
      if (base === null) return { error: noBookmark(dirPart) };
      const dir = a.resolve(this.cwd, expandHome(base || ".", this.d.paths));
      if (glob) {
        const re = globRegExp(namePart, this.d.paths.platform === "win32" || this.d.paths.platform === "darwin", nameOn);
        // loop: NOT-WORTH — one async readdir per pattern
        const names = await this.d.fs.readdir(dir).catch(() => [] as Dirent[]);
        // loop: NOT-WORTH — one folder's names
        const hits = names.filter((n) => re.test(n.name) && (namePart.startsWith(".") || !n.name.startsWith("."))).map((n) => n.name);
        if (!hits.length) return { error: `no file matches ${w.value}` };
        // the cap before the items are added (a spread of 130 000 matches overflowed the stack: review 2026-10-27 M4)
        if (out.length + hits.length > ITEMS_MAX) return { error: tooMany };
        // loop: NOT-WORTH — sorts ≤ ITEMS_MAX matches, then adds them one by one
        for (const n of hits.sort(naturalCompare)) out.push(dirPart + n);
      } else if (token) {
        const pat = await this.patternAt(a.join(dir, namePart));
        if (pat && !pat.seq) return { error: noFrames(pat, this.opts) };
        const names = pat?.seq ? pat.seq.names : null;
        if (out.length + (names?.length ?? 1) > ITEMS_MAX) return { error: tooMany };
        // loop: NOT-WORTH — ≤ ITEMS_MAX frames, added one by one
        if (names) for (const n of names) out.push(dirPart + n);
        else out.push(w.value);
      } else out.push(w.value);
      if (out.length > ITEMS_MAX) return { error: tooMany };
    }
    return out;
  }

  // --- corridorkey ---

  private async cli(b: ConsoleBlock, p: Parsed, inScript: boolean): Promise<{ block: ConsoleBlock; done: Promise<ConsoleBlock> }> {
    const now = (x: ConsoleBlock) => ({ block: x, done: Promise.resolve(x) });
    const cmd = p.command!;
    const bin = this.d.cli();
    if (!bin) return now(this.finish(b, "refused", "The corridorkey command line isn't part of this copy of the app (it ships next to the engine, in resources/engine)."));
    if (this.job && !(inScript && this.job.block.id === b.parent)) return now(this.finish(b, "refused", `Busy with ${this.job.block.line} (one command at a time; Ctrl+C stops it).`));

    // the arguments, checked: written paths only into chosen folders (resolved: what was checked is what runs),
    // the runtime only from the Engine page's lists, the job file's own output folders too
    const argv: string[] = [cmd.name];
    const positionals: string[] = [];
    const abs = (v: string) => (this.d.paths.platform === "win32" ? win32 : posix).resolve(this.cwd, expandHome(v, this.d.paths));
    const targets: string[] = [];
    const refusals: string[] = [];
    // loop: NOT-WORTH — the line's few options
    const given = new Set(p.options.map((o) => o.arg.id));
    const jobFlags: string[] = [];
    const job: { input: string | null } = { input: null };
    const versions: string[] = [];
    const pathValue = async (a: ConsoleArg, v: string): Promise<string> => {
      // --ocio's ocio://… names a built-in config, not a file; any other value is a path (C://… is one on Windows)
      if (a.id === "ocio" && !a.writes && v.startsWith("ocio://")) return v;
      if (a.writes && a.id === "output" && cmd.name === "render") {
        // -o key/sh010_v###/: the next free version, so the render replaces nothing (S9)
        const dir = (p: string) => (this.d.paths.platform === "win32" ? win32 : posix).resolve(this.cwd, expandHome(p || ".", this.d.paths));
        const first = nextVersion(v, [], this.d.paths.platform);
        // loop: NOT-WORTH — one async readdir per versioned -o
        const names = first ? await this.d.fs.readdir(dir(first.parent)).catch(() => [] as Dirent[]) : [];
        // loop: NOT-WORTH — one folder's names
        const taken = names.map((n) => n.name);
        const next = first && nextVersion(v, taken, this.d.paths.platform);
        if (next) {
          const w = await checkWrite(next.path, this.cwd, this.d.writeRoots(), this.d.paths);
          if (w.ok) versions.push(w.path);
          v = next.path;
        }
      }
      if (a.writes) {
        const w = await checkWrite(v, this.cwd, this.d.writeRoots(), this.d.paths);
        if (!w.ok) refusals.push(`${a.long ? `--${a.long}` : a.id}: ${w.reason}`);
        targets.push(w.path);
        return w.path;
      }
      return expandHome(v, this.d.paths);
    };
    // loop: NOT-WORTH — the line's options, one async realpath per written path
    for (const o of p.options) {
      const flag = o.arg.long ? `--${o.arg.long}` : `-${o.arg.short}`;
      if (o.value === null) {
        argv.push(flag);
        continue;
      }
      // an enum's value as the CLI spells it (EXR → exr)
      let v = o.arg.kind === "path" ? await pathValue(o.arg, o.value) : o.arg.kind === "enum" ? (enumValue(o.arg, o.value) ?? o.value) : o.value;
      if (o.arg.id === "models" || o.arg.id === "ort") {
        v = abs(v);
        if (!this.d.runtimeAllowed(o.arg.id, v))
          refusals.push(`${flag}: the Console runs only the ${o.arg.id === "ort" ? "ONNX Runtime" : "model sets"} the Engine page lists (${v} isn't one; add it there first)`);
      }
      // a value starting with - joined to its flag, or clap reads it as a flag of its own (senior review 2026-10-26 N1)
      if (v.startsWith("-")) argv.push(`${flag}=${v}`);
      else argv.push(flag, v);
      if (o.arg.id === "job") jobFlags.push(...(await this.jobFileFlags(v, cmd.args, given, targets, refusals, job)));
    }
    // the job file's folders, checked and resolved, as flags (flags win over the file): the CLI uses what was checked
    // loop: NOT-WORTH — at most two flags
    for (let i = 0; i < jobFlags.length; i += 2) given.add(jobFlags[i].slice(2));
    argv.push(...jobFlags);
    // loop: NOT-WORTH — the line's positionals (render's clip)
    for (const x of p.positionals) positionals.push(x.arg.kind === "path" ? await pathValue(x.arg, x.value) : x.value);
    // the clip after `--`: a name starting with - is never read as a flag
    if (positionals.length) argv.push("--", ...positionals);
    // what the user asked for, as the dialog shows it (before the Console's own flags go in)
    const asked = argv.slice(1);
    // --progress-format json: progress as events (render, verify, prepare); render's temporary files in the app's cache
    // loop: NOT-WORTH — a command's ~50 flags
    if (cmd.args.some((a) => a.id === "progress-format")) argv.splice(1, 0, ...PROGRESS);
    const temp = cmd.name === "render" && !given.has("temp") ? this.d.cliTemp() : null;
    if (temp) argv.splice(1, 0, "--temp", temp);
    b.argv = argv;
    if (refusals.length) return now(this.finish(b, "refused", ...refusals));
    // the version picked, said and audited (what was written where is findable later: history --audit)
    // loop: NOT-WORTH — at most one versioned -o
    for (const v of versions) this.note(b, "info", `-o: the next free version is ${v}`);
    // loop: NOT-WORTH — one async append per versioned render [bounded: a local file write]
    if (versions.length && !(await this.d.audit.append({ event: "version", argv: [b.line], targets: versions }))) return now(this.finish(b, "refused", AUDIT_FAILED));

    // destructive: only as sudo, and confirmed (or already elevated)
    // the clip's name (render's own naming: docs/CLI.md "Outputs"): the files the run writes start with it
    // loop: NOT-WORTH — the line's few arguments
    const input = p.positionals.find((x) => x.arg.id === "clip")?.value ?? p.options.find((o) => o.arg.id === "input")?.value ?? job.input;
    const refusal = await this.elevate(b, p, asked, argv, targets, inScript, input ? clipName(input, this.d.paths.platform) : null);
    if (refusal) return now(refusal);
    if (temp) {
      try {
        // loop: NOT-WORTH — one async mkdir per render
        await this.d.fs.mkdir(temp);
      } catch (e) {
        // error: SHOWN — the block says why
        return now(this.finish(b, "failed", `Can't make the temporary folder: ${fsErrorText(e, temp)}. --temp <folder> names another one.`));
      }
    }
    // every elevated command is logged before it runs: unlogged, it doesn't run
    if (b.elevated && !(await this.d.audit.append({ event: "run", argv, targets }))) {
      b.elevated = false;
      return now(this.finish(b, "refused", AUDIT_FAILED));
    }
    // the dialog (and the folder) took time: another command may have started meanwhile; a command still in its checks
    // when the app quits never starts (shutdown() stops only what runs)
    const blocked = () =>
      this.job && !(inScript && this.job.block.id === b.parent) ? `Busy with ${this.job.block.line} (one command at a time).` : this.closing ? "Not run: the app is quitting." : null;
    const busy = blocked() ?? (cmd.name === "info" ? this.d.gpuBusy() : null);
    if (busy) return now(this.finish(b, "refused", busy));
    if (cmd.gpu) {
      // taking the card waits for the engines it stops to exit (senior review 2026-10-26 N9): check the slot again
      // after it; from there to the spawn nothing awaits, so the slot can't be taken twice
      // loop: NOT-WORTH — one wait per command that uses the card, for the engines it stopped [bounded: GPU_RELEASE_MS in index.ts]
      const gpuRefusal = await this.d.takeGpu();
      if (gpuRefusal) return now(this.finish(b, "refused", gpuRefusal));
      const late = blocked();
      if (late) {
        this.d.releaseGpu();
        return now(this.finish(b, "refused", late));
      }
    }
    return this.spawnCli(b, bin, argv, cmd.gpu, inScript, targets);
  }

  /**
   * A line with a flag that replaces files: refused unless it says sudo; a script's line only under the script's own
   * confirmation; else the session's elevation, asked for with a native dialog naming the line, the command (`asked`:
   * its words as the user gave them) and what it replaces (`targets`; `clip`: the run's own names in a folder), audited.
   * Null: it may run (b.elevated says whether it is elevated); else the refused block.
   */
  private async elevate(b: ConsoleBlock, p: Parsed, asked: string[], argv: string[], targets: string[], inScript: boolean, clip: string | null): Promise<ConsoleBlock | null> {
    const cmd = p.command!;
    // loop: NOT-WORTH — the line's options
    const destructive = p.options.filter((o) => o.arg.destructive);
    if (!destructive.length) return null;
    if (!p.sudo)
      // loop: NOT-WORTH — one or two flags
      return this.finish(b, "refused", `${destructive.map((o) => o.name).join(", ")} replaces files that are already there: run it as sudo ${b.line.trim()}${inScript ? "" : " (or type sudo !!)"}`);
    if (inScript) {
      // a script's line: covered only by its own confirmation up front, never by (or extending) the session's elevation
      if (!this.job?.scriptGrant) return this.finish(b, "refused", "Not run: a script's line that replaces files runs only after the script's own confirmation.");
      b.elevated = true;
      return null;
    }
    if (!this.d.elevation.active) {
      const req: ElevationRequest = {
        line: visible(b.line.trim()),
        // loop: NOT-WORTH — the command's few words
        command: visible(`sudo ${fullName(this.d.registry, cmd)} ${asked.map((w) => (w === "--" ? w : quoteArg(w, this.opts))).join(" ")}`),
        targets: await this.measureTargets(targets, clip),
      };
      const ok = await this.d.confirm(req);
      const logged = await this.d.audit.append({ event: ok ? "granted" : "refused", argv, targets });
      if (!ok) return this.finish(b, "refused", "Not run: the confirmation was cancelled.");
      if (!logged) return this.finish(b, "refused", AUDIT_FAILED);
      this.d.elevation.grant();
    } else this.d.elevation.extend();
    this.armExpiry();
    b.elevated = true;
    this.d.sessionChanged();
    return null;
  }

  /**
   * A --job file names its own output and temporary folders: they are checked as -o and --temp are, and returned as
   * resolved `--output` / `--temp` flags (flags win over the file, docs/CLI.md), so the CLI uses what was checked even
   * if the file changes after this. A file the app can't fully read and parse is refused (never passed on unchecked).
   */
  private async jobFileFlags(path: string, args: readonly ConsoleArg[], given: Set<string>, targets: string[], refusals: string[], seen: { input: string | null }): Promise<string[]> {
    let job: unknown;
    try {
      const abs = (this.d.paths.platform === "win32" ? win32 : posix).resolve(this.cwd, path);
      job = JSON.parse(await this.d.fs.readFile(abs, FILE_MAX));
    } catch (e) {
      // error: SHOWN — refused with the reason: what isn't checked doesn't run
      refusals.push(
        `--job: can't check it: ${e instanceof SyntaxError ? `${path} isn't valid JSON (${e.message})` : fsErrorText(e, path)}; the Console runs a job file only once it has read and checked it`,
      );
      return [];
    }
    const fields = job && typeof job === "object" ? (job as { input?: unknown; output_dir?: unknown; temp_dir?: unknown }) : {};
    if (typeof fields.input === "string") seen.input = fields.input;
    const flags: string[] = [];
    // loop: NOT-WORTH — two fields, one async realpath each
    for (const [flag, v, key] of [
      ["output", fields.output_dir, "output_dir"],
      ["temp", fields.temp_dir, "temp_dir"],
    ] as const) {
      // loop: NOT-WORTH — a command's ~50 flags
      if (given.has(flag) || typeof v !== "string" || !v || !args.some((a) => a.id === flag && a.writes)) continue;
      const w = await checkWrite(v, this.cwd, this.d.writeRoots(), this.d.paths);
      if (!w.ok) refusals.push(`--job's ${key}: ${w.reason}`);
      targets.push(w.path);
      flags.push(`--${flag}`, w.path);
    }
    return flags;
  }

  /**
   * The dialog's numbers: what the run would replace in each written target (files and bytes there now). A folder: the
   * files at the clip's names (`<clip>_…`, and inside its `<clip>_…_exr` folders), the whole folder when the clip is
   * unknown; a frame pattern: its frames in its folder; a file: itself.
   */
  private async measureTargets(paths: string[], clip: string | null): Promise<ElevationRequest["targets"]> {
    const a = this.d.paths.platform === "win32" ? win32 : posix;
    const out: ElevationRequest["targets"] = [];
    const ours = (n: string) => clip === null || n.startsWith(`${clip}_`);
    // loop: NOT-WORTH — one or two targets per elevation
    for (const path of paths) {
      const s = await this.d.fs.stat(path).catch(() => null);
      if (s?.isFile()) out.push({ path: visible(path), files: 1, bytes: s.size });
      else if (s?.isDirectory()) out.push({ path: visible(path), ...(await this.walk(path, ours, true, undefined, ours)) });
      else {
        // key.####.exr / key.%04d.exr / key.$F4.exr: its frames (and key_alpha.1001.exr…) in the parent folder
        const base = a.basename(path);
        const m = /(#+|%0?\d*d|\$F\d*)/.exec(base);
        if (!m) {
          out.push({ path: visible(path), files: 0, bytes: 0 });
          continue;
        }
        const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`^${esc(base.slice(0, m.index).replace(/[._]+$/, ""))}.*\\d+${esc(base.slice(m.index + m[0].length))}$`);
        out.push({ path: visible(path), ...(await this.walk(a.dirname(path), (n) => re.test(n), false)) });
      }
    }
    return out;
  }

  private async walk(
    dir: string,
    keep: (name: string) => boolean,
    deep = true,
    budget: { left: number; stop?: () => boolean } = { left: 200_000 },
    enter: (name: string) => boolean = () => true,
  ): Promise<{ files: number; bytes: number }> {
    const a = this.d.paths.platform === "win32" ? win32 : posix;
    let files = 0;
    let bytes = 0;
    let names: Dirent[];
    try {
      // loop: NOT-WORTH — one async readdir per folder, per folder a sudo confirmation counts (or du) [bounded: 200 000 entries per folder counted (du: DU_ENTRIES in all)]
      names = await this.d.fs.readdir(dir);
    } catch {
      // error: NOT-WORTH — unreadable: counted as empty
      return { files, bytes };
    }
    // loop: NOT-WORTH — one async stat per entry, per folder a sudo confirmation counts (or du) [bounded: 200 000 entries per folder counted (du: DU_ENTRIES in all; Ctrl+C at each)]
    for (const n of names) {
      if (budget.left-- <= 0 || budget.stop?.()) break;
      if (n.isDirectory()) {
        if (!deep || !enter(n.name)) continue;
        const sub = await this.walk(a.join(dir, n.name), keep, deep, budget, enter);
        files += sub.files;
        bytes += sub.bytes;
      } else if (keep(n.name)) {
        files++;
        bytes += (await this.d.fs.stat(a.join(dir, n.name)).catch(() => null))?.size ?? 0;
      }
    }
    return { files, bytes };
  }

  private spawnCli(b: ConsoleBlock, bin: string, argv: string[], gpu: boolean, inScript: boolean, targets: string[]): { block: ConsoleBlock; done: Promise<ConsoleBlock> } {
    const win = this.d.paths.platform === "win32";
    // detached: its own process group, so a second Ctrl+C also ends the ffmpeg writers it started (Linux, macOS; on
    // Windows detached would open a console window: the tree is ended with taskkill instead)
    const child = this.spawnFn(bin, argv, { cwd: this.cwd, env: this.d.cliEnv(), shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !win });
    const own = !inScript;
    const job: Job = own ? { block: b, child, cancels: 0 } : this.job!;
    if (own) this.job = job;
    else job.child = child;
    this.d.sessionChanged();
    this.d.changed(b);
    let failMessage: string | null = null;
    // lifetime: OK — both readers end with the child's streams
    createInterface({ input: child.stdout! }).on("line", (l) => {
      const ev = jsonEvent(l);
      if (!ev) return this.note(b, "out", l);
      if (ev.event === "progress") b.progress = { percent: num(ev.percent), done: num(ev.done), total: num(ev.total) };
      else if (ev.event === "status") b.status = String(ev.text ?? "");
      else if (ev.event === "fail") failMessage = `failed: ${String(ev.message ?? "")} (${String(ev.reason ?? "")})`;
      else return this.note(b, "out", l);
      this.d.changed(b);
    });
    createInterface({ input: child.stderr! }).on("line", (l) => this.note(b, "err", l));
    return {
      block: b,
      done: new Promise<ConsoleBlock>((resolve) => {
        let ended = false;
        const end = (code: number | null, signal: NodeJS.Signals | null, err?: Error) => {
          if (ended) return;
          ended = true;
          if (gpu) this.d.releaseGpu();
          if (own) this.job = null;
          else job.child = null;
          b.exitCode = code;
          b.exitMeaning = code !== null ? (EXIT_MEANINGS[code] ?? null) : null;
          if (failMessage) this.note(b, "err", failMessage);
          if (err) this.note(b, "err", `corridorkey couldn't start: ${err.message}`);
          else if (code === null) this.note(b, "err", `ended by ${signal ?? "a signal"}`);
          // stopped by Ctrl+C: 143 (130) on Linux and macOS; Windows' taskkill gives another code
          const cancelled = job.cancels > 0 && code !== 0;
          this.d.sessionChanged();
          const state = code === 0 ? "done" : cancelled ? "cancelled" : "failed";
          if (!b.elevated) return resolve(this.finish(b, state));
          // loop: NOT-WORTH — one async append per elevated command's end [bounded: a local file write]
          void this.d.audit.append({ event: "exit", argv, exit: code }).then((ok) => {
            if (!ok) this.note(b, "err", "The audit log couldn't record this command's exit.");
            resolve(this.finish(b, state));
          });
        };
        child.on("error", (e) => end(null, null, e));
        child.on("close", (code, signal) => end(code, signal));
      }),
    };
  }

  private killTree(pid: number): void {
    if (this.d.killTree) return this.d.killTree(pid);
    if (this.d.paths.platform === "win32") {
      // Windows has no process groups (a negative pid does nothing there): taskkill ends the tree, as engine.ts does;
      // by its full path (a bare name would be looked for in the current folder first)
      const child = this.job?.child;
      const taskkill = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
      // loop: NOT-WORTH — one taskkill per cancel [bounded: taskkill ends by itself]
      this.spawnFn(taskkill, ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false }).on("error", () => child?.kill());
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // error: NOT-WORTH — the group is already gone; the exit handler reports it
    }
  }

  /** The page's badge drops when the elevation runs out: one timer, re-armed by each grant or extension. */
  private armExpiry(): void {
    this.clearExpiry();
    const at = this.d.elevation.expiresAt;
    if (at === null) return;
    // lifetime: OK — one-shot, cleared by the next grant, extension or drop
    // loop: NOT-WORTH — one timer per elevation change
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      if (!this.d.elevation.active) {
        void this.d.audit.append({ event: "dropped", reason: "timed out" });
        this.d.sessionChanged();
      }
    }, at - this.now());
    this.expiryTimer.unref?.();
  }

  private clearExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }
}

/** A running program's state (program, runList). */
interface RunCtx {
  b: ConsoleBlock;
  job: Job;
  /** the script's name (its lines are noted as name:N), null for a typed line */
  name: string | null;
  keepGoing: boolean;
  /** the status of the failure that stopped it (or the last one counted) */
  failed: number | null;
  stopped: boolean;
  failures: number;
  /** the loops' variables, over the session's */
  scope: Map<string, string>;
  /** the commands run so far, nested loops' too (at most PROGRAM_COMMANDS_MAX) */
  commands: number;
}

/** du's entries counted, at most (then its sizes say ≥). */
const DU_ENTRIES = 200_000;
/** tree's rows, at most; its depth, at most. */
const TREE_ROWS = 1000;
const TREE_DEPTH_MAX = 6;

/** A for loop's items, at most. */
const ITEMS_MAX = 10_000;
/** A program's commands, at most, loops inside loops included (each command is a block on the page). */
const PROGRAM_COMMANDS_MAX = 10_000;

/** time's line: how long it took; a render's frames and frames per second (from its own JSON events). */
function timeLine(b: ConsoleBlock, ms: number): string {
  const s = ms / 1000;
  const frames = b.progress && b.progress.done > 0 ? ` · ${b.progress.done} frames · ${s > 0 ? (b.progress.done / s).toFixed(2) : "?"} fps` : "";
  return `time: ${s.toFixed(1)} s${frames} (${b.line})`;
}

/** Variables set in a session, at most. */
const VARIABLES_SESSION_MAX = 500;

/** A block's exit status for `${status}` (and the next line): its exit code, else 0 done, 2 refused, 130 stopped, 1 failed. */
export function statusOf(b: ConsoleBlock): number {
  if (b.exitCode !== null) return b.exitCode;
  return b.state === "done" ? 0 : b.state === "refused" ? 2 : b.state === "cancelled" ? 130 : 1;
}

/** pushd's folders, at most. */
const STACK_MAX = 50;
/** j alone: the folders listed. */
const JUMP_LISTED = 20;
const noBookmark = (path: string | undefined) => `No bookmark ${(path ?? "").slice(1).split(/[\\/]/)[0]} (bookmarks lists them; bookmark <name> <folder> makes one).`;

/** doctor: how long `corridorkey info` may take (it loads ONNX Runtime and asks the driver). */
const INFO_TIMEOUT_MS = 30_000;
/** doctor's free space marks: ✗ under 2 GiB (a render fails soon), ⚠ under 20 GiB (an EXR shot can take that). */
const DISK_FULL = 2 * 2 ** 30;
const DISK_LOW = 20 * 2 ** 30;

const RUNTIME_FIX = "App: Engine page → Runtime and models (download the GPU runtime, or choose one it lists)";
const MODELS_FIX = "App: Engine page → Runtime and models (download the models)";

/** doctor's rows from `corridorkey info --json` (ck-cli run.rs info): the card, ONNX Runtime, the models. */
function infoRows(r: { info: Record<string, unknown> } | { error: string }): DoctorRow[] {
  // info stops at the first of the two it can't open: the runtime ("ONNX Runtime didn't load …"), else the model set
  if ("error" in r)
    return /ONNX Runtime|couldn't start|no JSON|ended with/.test(r.error)
      ? [
          { check: "ONNX Runtime", status: "fail", detail: r.error, fix: RUNTIME_FIX },
          { check: "Graphics card", status: "warn", detail: "not checked: ONNX Runtime first", fix: RUNTIME_FIX },
        ]
      : [
          { check: "Models", status: "fail", detail: r.error, fix: MODELS_FIX },
          { check: "Graphics card", status: "warn", detail: "not checked: the models first", fix: MODELS_FIX },
        ];
  const i = r.info as {
    onnxruntime?: string;
    provider?: string | null;
    precision?: string | null;
    unavailable?: string | null;
    gpu?: { name: string; driver: string; vram_total_mb: number } | null;
    // assets: each network's name and whether its file is there (ck-core runtime.rs ModelSet::assets)
    models?: { dir: string; set: string | null; assets: Record<string, boolean> | null } | null;
  };
  const rows: DoctorRow[] = [];
  if (i.gpu && i.provider && i.provider !== "cpu")
    rows.push({
      check: "Graphics card",
      status: "ok",
      detail: `${i.gpu.name} · driver ${i.gpu.driver} · ${gibBytes(i.gpu.vram_total_mb * 2 ** 20)} · ${i.provider} (${i.precision ?? "?"})`,
      fix: null,
    });
  else if (i.provider === "cpu" || i.provider === "coreml")
    rows.push({
      check: "Graphics card",
      status: i.provider === "cpu" ? "warn" : "ok",
      detail: i.provider === "cpu" ? "none used: the CPU keys (slow)" : "Apple's Core ML",
      fix: i.provider === "cpu" ? RUNTIME_FIX : null,
    });
  else
    rows.push({
      check: "Graphics card",
      status: "fail",
      detail: i.unavailable ?? "no usable graphics card",
      fix: `${RUNTIME_FIX}; an NVIDIA card also needs its driver (nvidia-smi shows it)`,
    });
  rows.push({ check: "ONNX Runtime", status: "ok", detail: i.onnxruntime ?? "?", fix: null });
  if (!i.models) rows.push({ check: "Models", status: "fail", detail: "no model set", fix: MODELS_FIX });
  else {
    // loop: NOT-WORTH — five networks
    const missing = Object.entries(i.models.assets ?? {})
      // loop: NOT-WORTH — as above
      .filter(([, have]) => !have)
      .map(([name]) => name);
    rows.push(
      missing.length
        ? { check: "Models", status: "fail", detail: `${i.models.dir} has no ${missing.join(", ")} network${missing.length > 1 ? "s" : ""}`, fix: MODELS_FIX, path: i.models.dir }
        : { check: "Models", status: "ok", detail: `${i.models.set ?? "no manifest"} in ${i.models.dir}`, fix: null, path: i.models.dir },
    );
  }
  return rows;
}

/** The most lines `history` prints. */
const HISTORY_SHOWN_MAX = 1000;

/** An ISO time as local YYYY-MM-DD HH:MM (as dir shows dates); blanks when unknown. */
function localTime(iso: string | null): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return " ".repeat(16);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A pattern with no frame in its folder: said, with what to type. */
const noFrames = (pat: { dir: string; pattern: string }, opts: ParseOptions) => `No frame of ${pat.pattern} in ${pat.dir}. dir ${quoteArg(pat.dir, opts)} lists what is there.`;

/** Control and bidi characters as \u{…}: a dialog line shows exactly one line, in the order it is stored. */
// loop: NOT-WORTH — one pass over a dialog string
const visible = (t: string) => t.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`);

/** The clip's name as corridorkey names its outputs (ck-core clip.rs raw_clip_name): the file's stem, or the parent
 * folder's name for input/frames/rgb. */
export function clipName(input: string, platform: NodeJS.Platform): string {
  const a = platform === "win32" ? win32 : posix;
  const p = a.normalize(input).replace(/[\\/]+$/, "");
  const base = a.basename(p);
  const trimmed = base.replace(/^\.+/, "");
  const dot = trimmed.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, base.length - trimmed.length + dot) : base;
  if (["input", "frames", "rgb"].includes(stem.toLowerCase())) return a.basename(a.dirname(p)) || stem;
  return stem;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A JSON progress event line ({"event": …}), else null (the CLI's other stdout lines are shown as they are). */
function jsonEvent(l: string): Record<string, unknown> | null {
  if (!l.startsWith("{")) return null;
  try {
    const v = JSON.parse(l) as unknown;
    return v && typeof v === "object" && typeof (v as { event?: unknown }).event === "string" ? (v as Record<string, unknown>) : null;
  } catch {
    // error: NOT-WORTH — not an event: shown as a line
    return null;
  }
}
