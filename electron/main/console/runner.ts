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
import { parse, quoteArg, type Parsed, type ParseOptions } from "../../../src/shared/console/parse";
import { EXIT_MEANINGS, fullName, type ConsoleArg, type Registry } from "../../../src/shared/console/registry";
import type { ConsoleBlock, ConsoleEntry, ConsoleSession } from "../../../src/shared/types";
import { complete } from "./complete";
import type { Elevation } from "./elevation";
import { commandHelp, findLines, overview } from "./help";
import type { AuditLog, History } from "./logs";
import { checkWrite, expandHome, resolveReal, type PathDeps } from "./paths";
import { groupSequences } from "../../../src/shared/console/sequences";
import { fileSizeText } from "../../../src/shared/units";

/** Lines a block keeps (the newest); a long render's log can't grow the page or the pushes without bound. */
export const CONSOLE_LINES_KEPT = 2000;
const LINE_CHARS = 4000;
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
  readFile: (p: string, maxBytes: number) => Promise<string>;
  mkdir: (p: string) => Promise<void>;
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
  /** the folders the Console may write to */
  writeRoots: () => string[];
  /** take the graphics card for a job: null when taken, else why not (the queue runs) */
  takeGpu: () => string | null;
  releaseGpu: () => void;
  /** the native confirmation (index.ts: dialog.showMessageBox); true: confirmed */
  confirm: (req: ElevationRequest) => Promise<boolean>;
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
  /** the app's version: its corridorkey's too (built together, one number: ck-cli lib.rs VERSION) */
  version: string;
}

interface Job {
  block: ConsoleBlock;
  child: ChildProcess | null;
  cancels: number;
}

const AUDIT_FAILED = "Not run: the audit log couldn't record it (every elevated command is logged first; see the app's log for why).";

/** The CLI's progress as JSON events (docs/CLI.md "Progress"): the Console shows them itself. */
const PROGRESS = ["--progress-format", "json"];

export class Console {
  private cwd: string;
  /** the folder before the last cd (cd -) */
  private prevCwd: string | null = null;
  private job: Job | null = null;
  private nextId = 1;
  private expiryTimer: NodeJS.Timeout | null = null;
  private readonly spawnFn: SpawnFn;
  private readonly now: () => number;
  private readonly opts: ParseOptions;
  /** set by shutdown(): from then on nothing spawns */
  private closing = false;

  constructor(private readonly d: ConsoleDeps) {
    this.cwd = d.startDir;
    this.spawnFn = d.spawn ?? nodeSpawn;
    this.now = d.now ?? Date.now;
    this.opts = { windows: d.paths.platform === "win32" };
  }

  session(): ConsoleSession {
    return { cwd: this.cwd, elevatedUntil: this.d.elevation.expiresAt, running: this.job?.block.line ?? null, cliFound: this.d.cli() !== null };
  }

  /** Run a typed line. Resolves with its block once it is done, or (corridorkey, run) once it has started. */
  async run(line: string): Promise<ConsoleBlock> {
    void this.d.history.add(line);
    // a job's block finishes later (its updates are pushed); a built-in's is finished here
    return (await this.runLine(line, null)).block;
  }

  /** Ctrl+C: SIGTERM (the CLI stops after the frame it is on, cleanly, 143); again: the whole group at once. */
  cancel(): void {
    const job = this.job;
    if (!job) return;
    job.cancels++;
    const pid = job.child?.pid;
    if (job.cancels === 1) {
      this.note(job.block, "info", job.child ? "Stopping after the current frame (Ctrl+C again stops it at once)…" : "Stopping the script after this command…");
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
    });
  }

  history(query: string): string[] {
    return this.d.history.search(query);
  }

  /** sudo -k, the window's blur, quit: elevation ends (and the audit log says why). */
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
    b.lines.push({ kind, text: text.length > LINE_CHARS ? text.slice(0, LINE_CHARS) + "…" : text });
    if (b.lines.length > CONSOLE_LINES_KEPT) b.linesDropped += b.lines.splice(0, b.lines.length - CONSOLE_LINES_KEPT).length;
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

  /** One line: parsed, checked, run. `done` settles when it has finished (a script waits on it). */
  private async runLine(line: string, parent: number | null): Promise<{ block: ConsoleBlock; done: Promise<ConsoleBlock> }> {
    const b = this.block(line, parent);
    const now = (x: ConsoleBlock) => ({ block: x, done: Promise.resolve(x) });
    const p = parse(line, this.d.registry, this.opts);
    if (p.errors.length) {
      b.errors = p.errors;
      // loop: NOT-WORTH — a line's few mistakes
      return now(this.finish(b, "refused", ...p.errors.map((e) => e.message)));
    }
    const cmd = p.command;
    if (!cmd) return now(this.finish(b, "done"));
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
      case "dir":
        return now(await this.dir(b, pos("folder")[0], p));
      case "version":
        return now(this.finish(b, "done", `CorridorKey ${this.d.version} (the app and its corridorkey command line: one version)`));
      case "cls":
        b.clear = true;
        return now(this.finish(b, "done"));
      case "history":
        return now(await this.historyBlock(b, has("audit")));
      case "sudo":
        this.dropElevation("sudo -k");
        return now(this.finish(b, "done", "Not elevated."));
      case "run":
        return this.script(b, pos("file")[0], parent !== null);
    }
    return now(this.finish(b, "refused", `${cmd.name} isn't a command this Console runs.`));
  }

  private async cd(b: ConsoleBlock, to: string | undefined, back = false): Promise<ConsoleBlock> {
    if (back) {
      if (this.prevCwd === null) return this.finish(b, "failed", "No previous folder yet: cd - goes back to the folder you were in before the last cd.");
      to = this.prevCwd;
    }
    let dir: string;
    try {
      dir = await resolveReal(to ?? this.d.paths.home, this.cwd, this.d.paths);
      // loop: NOT-WORTH — one async stat per cd
      if (!(await this.d.fs.stat(dir)).isDirectory()) return this.finish(b, "failed", `${dir} isn't a folder.`);
    } catch (e) {
      // error: SHOWN — the block says why
      return this.finish(b, "failed", `Can't go to ${to}: ${(e as Error).message}`);
    }
    this.prevCwd = this.cwd;
    this.cwd = dir;
    this.d.sessionChanged();
    return this.finish(b, "done", dir);
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
    const dir = a.resolve(this.cwd, expandHome(folder ?? ".", this.d.paths));
    let names: Dirent[];
    try {
      // loop: NOT-WORTH — one async readdir per dir / ls
      names = await this.d.fs.readdir(dir);
    } catch (e) {
      // error: SHOWN — the block says why
      return this.finish(b, "failed", `Can't list ${dir}: ${(e as Error).message}`);
    }
    // dot files only with -a (ls's rule; dir /a)
    const all = has("all");
    const total = names.length;
    // loop: NOT-WORTH — one folder's names, per dir / ls
    names = all ? names : names.filter((n) => !n.name.startsWith("."));
    const hidden = total - names.length;
    // loop: NOT-WORTH — sorts one folder's names, per dir / ls
    names.sort((x, y) => naturalCompare(x.name, y.name));
    // a sequence is one row (lsseq: sh010_plate.####.exr  1001-1100, its gaps), unless -f asks for the frames
    // loop: NOT-WORTH — one folder's names
    const grouped = has("frames") ? { sequences: [], singles: names.map((n) => n.name) } : groupSequences(names.filter((n) => !n.isDirectory()).map((n) => n.name));
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
      `, ${entries.length - files.length} folders${more > 0 ? `; ${more} more not listed` : ""}${hidden > 0 ? `; ${hidden} hidden (dir -a shows them)` : ""}`;
    if (has("names")) {
      // names only (ls -1, dir /w /b): one per line, folders with a separator
      b.entries = null;
      // loop: NOT-WORTH — ≤ LIST_MAX names, per dir -1
      return this.finish(b, "done", ...entries.map((e) => e.name + (e.folder ? a.sep : "")));
    }
    return this.finish(b, "done", summary);
  }

  private async historyBlock(b: ConsoleBlock, audit: boolean): Promise<ConsoleBlock> {
    if (!audit) {
      const lines = this.d.history.recent(50);
      // loop: NOT-WORTH — ≤ 50 lines, once per history
      return this.finish(b, "done", ...(lines.length ? lines.map((l, i) => `${String(i + 1).padStart(4)}  ${l}`) : ["No history yet."]));
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

  /** run <file.ckcmd>: each line through runLine (the same checks), in order, until one fails. */
  private async script(b: ConsoleBlock, file: string, nested: boolean): Promise<{ block: ConsoleBlock; done: Promise<ConsoleBlock> }> {
    const now = (x: ConsoleBlock) => ({ block: x, done: Promise.resolve(x) });
    if (nested) return now(this.finish(b, "refused", "A script can't run another script."));
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
      return now(this.finish(b, "failed", `Can't read ${path}: ${(e as Error).message}`));
    }
    const done = (async () => {
      let failed: ConsoleBlock | null = null;
      // loop: SERIAL-REQUIRED — a script's lines run one after another, each waiting for the last [bounded: the file's lines]
      for (const [i, raw] of text.split(/\r?\n/).entries()) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        if (job.cancels > 0 || this.closing) break;
        this.note(b, "info", `${a.basename(path)}:${i + 1}  ${line}`);
        const r = await this.runLine(line, b.id);
        const end = await r.done;
        if (end.state !== "done") {
          failed = end;
          this.note(b, "err", `stopped at line ${i + 1}: ${end.state}${end.exitCode !== null ? ` (exit ${end.exitCode})` : ""}`);
          break;
        }
      }
      this.job = null;
      this.d.sessionChanged();
      if (job.cancels > 0) return this.finish(b, "cancelled");
      if (failed) {
        b.exitCode = failed.exitCode;
        return this.finish(b, "failed");
      }
      return this.finish(b, "done");
    })();
    return { block: b, done };
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
    const pathValue = async (a: ConsoleArg, v: string): Promise<string> => {
      // --ocio's ocio://… names a built-in config, not a file; any other value is a path (C://… is one on Windows)
      if (a.id === "ocio" && !a.writes && v.startsWith("ocio://")) return v;
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
      let v = o.arg.kind === "path" ? await pathValue(o.arg, o.value) : o.value;
      if (o.arg.id === "models" || o.arg.id === "ort") {
        v = abs(v);
        if (!this.d.runtimeAllowed(o.arg.id, v))
          refusals.push(`${flag}: the Console runs only the ${o.arg.id === "ort" ? "ONNX Runtime" : "model sets"} the Engine page lists (${v} isn't one; add it there first)`);
      }
      argv.push(flag, v);
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

    // destructive: only as sudo, and confirmed (or already elevated)
    // loop: NOT-WORTH — the line's options
    const destructive = p.options.filter((o) => o.arg.destructive);
    // loop: NOT-WORTH — one or two flags
    if (destructive.length && !p.sudo) return now(this.finish(b, "refused", `${destructive.map((o) => o.name).join(", ")} replaces files that are already there: run it as sudo ${b.line.trim()}`));
    if (p.sudo && destructive.length) {
      if (!this.d.elevation.active) {
        // the clip's name (render's own naming: docs/CLI.md "Outputs"): the files the run writes start with it
        // loop: NOT-WORTH — the line's few arguments
        const input = p.positionals.find((x) => x.arg.id === "clip")?.value ?? p.options.find((o) => o.arg.id === "input")?.value ?? job.input;
        const req: ElevationRequest = {
          line: visible(b.line.trim()),
          // loop: NOT-WORTH — the command's few words
          command: visible(`sudo ${fullName(this.d.registry, cmd)} ${asked.map((w) => (w === "--" ? w : quoteArg(w, this.opts))).join(" ")}`),
          targets: await this.measureTargets(targets, input ? clipName(input, this.d.paths.platform) : null),
        };
        const ok = await this.d.confirm(req);
        const logged = await this.d.audit.append({ event: ok ? "granted" : "refused", argv, targets });
        if (!ok) return now(this.finish(b, "refused", "Not run: the confirmation was cancelled."));
        if (!logged) return now(this.finish(b, "refused", AUDIT_FAILED));
        this.d.elevation.grant();
        this.armExpiry();
      } else {
        this.d.elevation.extend();
        this.armExpiry();
      }
      b.elevated = true;
      this.d.sessionChanged();
    }
    if (temp) {
      try {
        // loop: NOT-WORTH — one async mkdir per render
        await this.d.fs.mkdir(temp);
      } catch (e) {
        // error: SHOWN — the block says why
        return now(this.finish(b, "failed", `Can't make ${temp}: ${(e as Error).message}`));
      }
    }
    // every elevated command is logged before it runs: unlogged, it doesn't run
    if (b.elevated && !(await this.d.audit.append({ event: "run", argv, targets }))) {
      b.elevated = false;
      return now(this.finish(b, "refused", AUDIT_FAILED));
    }
    // the dialog (and the folder) took time: another command may have started meanwhile; from here to the spawn
    // nothing awaits, so the slot can't be taken twice
    if (this.job && !(inScript && this.job.block.id === b.parent)) return now(this.finish(b, "refused", `Busy with ${this.job.block.line} (one command at a time).`));
    // a command still in its checks when the app quits never starts (shutdown() stops only what runs)
    if (this.closing) return now(this.finish(b, "refused", "Not run: the app is quitting."));
    const gpuRefusal = cmd.gpu ? this.d.takeGpu() : null;
    if (gpuRefusal) return now(this.finish(b, "refused", gpuRefusal));
    return this.spawnCli(b, bin, argv, cmd.gpu, inScript, targets);
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
      refusals.push(`--job: can't check ${path} (${(e as Error).message}); the Console runs a job file only once it has read and checked it`);
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

  private async walk(dir: string, keep: (name: string) => boolean, deep = true, budget = { left: 200_000 }, enter: (name: string) => boolean = () => true): Promise<{ files: number; bytes: number }> {
    const a = this.d.paths.platform === "win32" ? win32 : posix;
    let files = 0;
    let bytes = 0;
    let names: Dirent[];
    try {
      // loop: NOT-WORTH — one async readdir per folder, once per sudo confirmation [bounded: 200 000 entries]
      names = await this.d.fs.readdir(dir);
    } catch {
      // error: NOT-WORTH — unreadable: counted as empty
      return { files, bytes };
    }
    // loop: NOT-WORTH — one async stat per entry, once per sudo confirmation [bounded: 200 000 entries]
    for (const n of names) {
      if (budget.left-- <= 0) break;
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
