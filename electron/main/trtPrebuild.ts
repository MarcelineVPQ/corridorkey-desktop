// The background TensorRT build (Marcy, 2026-10-25: "a job must never sit in a TensorRT build again"). When TensorRT
// is switched on, and when its download finishes, the app builds the chosen sizes once, ahead of any job (Engine
// settings, TensorRT; 4K DCI 4096x2160 and HD 1920x1080 until the user chooses, backlog row 56), with the engine's own
// `trt_build` (the same window a job picks, the same builder, docs/ENGINE_PROTOCOL.md). Jobs send
// `tensorrt_build: false`, so until a range is built its clips run on CUDA.
//
// lifetime (rule 11): a short-lived engine of its own, only while no queue runs: the queue's start pauses it (the
// engine is killed, the builder dies with it) and its end resumes it (what was built is kept; a half-built network is
// built again). Not started by itself while other programs use the graphics card (Sonata); Build now starts it anyway.
import { access, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { EngineReply } from "./engine";
import type { EngineHandle } from "./queue";
import type { PrebuildRange, TrtPrebuild } from "../../src/shared/types";
import { trtSizeKey, TRT_PIECES, type TrtSize } from "../../src/shared/trt";
import { ENGINE_FAILED } from "../../src/shared/texts";

const existsAsync = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/**
 * The engine's stamp of a TensorRT-ready export (tensorrt.rs source_stamp, written to `<piece>.source` when a network
 * is built): "<bytes>:<modified, whole seconds>" of the .onnx and of its .onnx.data, "-" for one that can't be read.
 */
export async function sourceStamp(onnx: string): Promise<string> {
  const part = (p: string) =>
    stat(p, { bigint: true }).then(
      // whole seconds as Rust's as_secs (floored; a time before 1970 is 0 there too)
      (m) => `${m.size}:${m.mtimeNs > 0n ? m.mtimeNs / 1_000_000_000n : 0n}`,
      // error: NOT-WORTH — the engine writes "-" for a file it can't read, so does this
      () => "-",
    );
  // loop: NOT-WORTH — two async stats per network, when the app reads what is built
  return (await Promise.all([onnx, `${onnx}.data`].map(part))).join(",");
}

/**
 * The networks a range needs, with the stamp each must be built from: those with a TensorRT-ready export in the models
 * folder the engine runs with (runtime.rs trt_file: models.json "tensorrt-fp16", that file in the folder; pipeline
 * trt_dir_built). Null: no models folder, or a models.json the engine couldn't read (it doesn't start then).
 */
export async function trtStamps(models: string | null): Promise<Map<string, string> | null> {
  if (!models) return null;
  let manifest: Record<string, Record<string, string> | undefined> = {};
  try {
    manifest = JSON.parse(await readFile(join(models, "models.json"), "utf8")) as typeof manifest;
  } catch (e) {
    // error: NOT-WORTH — no models.json: the engine reads an empty one; an unreadable one stops the engine
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
  const stamps = new Map<string, string>();
  // loop: NOT-WORTH — five networks, one or two async stats each
  for (const p of TRT_PIECES) {
    const name = manifest["tensorrt-fp16"]?.[p];
    // Rust's Path::join: a name that is a whole path replaces the folder
    const f = name ? resolve(models, name) : null;
    if (f && (await existsAsync(f))) stamps.set(p, await sourceStamp(f));
  }
  return stamps;
}

/**
 * Every range folder in the TensorRT cache (`<root>/<card>/<range>`, engine tensorrt.rs cache_dir) and whether it is
 * built the way the engine decides (pipeline trt_dir_built): each network of `stamps` has its engine, stub and
 * `<piece>.source` with that stamp (tensorrt.rs built), or a remembered failed build of that stamp (`<piece>.failed`,
 * that network runs on CUDA). `stale`: not built, but every network has its stub or failed marker, from other model
 * files (the model set changed): it needs a rebuild. No `stamps` (the storage list, removals): built and stale false.
 * Async: the cache folder can be on a network share.
 */
// loop: NOT-WORTH — a few async readdirs and stats of the TensorRT cache, after a build, a job, a move or a removal (never per state push)
export async function trtRangeDirs(root: string, stamps: ReadonlyMap<string, string> | null = null): Promise<{ range: string; dir: string; built: boolean; stale: boolean }[]> {
  const dirs = (p: string) =>
    readdir(p).catch(
      // error: NOT-WORTH — no TensorRT engines built (the folder isn't there)
      () => [] as string[],
    );
  const text = (p: string) =>
    readFile(p, "utf8").then(
      (s) => s.trim(),
      // error: NOT-WORTH — no such file: not built from this stamp
      () => null,
    );
  const out: { range: string; dir: string; built: boolean; stale: boolean }[] = [];
  // loop: NOT-WORTH — one folder per card / driver (one or two), when the app reads what is built
  for (const card of await dirs(root)) {
    // loop: NOT-WORTH — a few ranges per card
    for (const range of (await dirs(join(root, card))).filter((n) => /^h\d+-\d+_w\d+-\d+_t/.test(n))) {
      const dir = join(root, card, range);
      let built = stamps !== null;
      let present = stamps !== null;
      // loop: NOT-WORTH — five networks, a few async reads each
      for (const [p, stamp] of stamps ?? []) {
        const d = join(dir, p);
        // tensorrt.rs built: the engine, its stub and the stamp it was built from
        const ok = (await existsAsync(join(d, `${p}.engine`))) && (await existsAsync(join(d, `${p}_ctx.onnx`))) && (await text(join(d, `${p}.source`))) === stamp;
        // tensorrt.rs failed_before (any working memory): the stamp, then the working memory's megabytes
        const failed = ((await text(join(d, `${p}.failed`))) ?? "").split("\n");
        if (!ok && !(failed[0].trim() === stamp && /^\+?\d+$/.test(failed[1]?.trim() ?? ""))) built = false;
        if (!(await existsAsync(join(d, `${p}_ctx.onnx`))) && !(await existsAsync(join(d, `${p}.failed`)))) present = false;
      }
      out.push({ range, dir, built, stale: !built && present });
    }
  }
  return out;
}

/** The built ranges' keys (what the waiting clip's line and the Engine page name), for the stamps of trtStamps. */
export async function builtRanges(root: string, stamps: ReadonlyMap<string, string> | null): Promise<string[]> {
  // loop: NOT-WORTH — a few ranges, when the app reads what is built
  return [...new Set((await trtRangeDirs(root, stamps)).filter((r) => r.built).map((r) => r.range))].sort();
}

/** The app's record of a range it built (in the range's folder; the engine ignores it): how long the build took here. */
export const BUILD_RECORD = ".corridorkey-build.json";

/**
 * A built or stale range's size on disk and recorded build time, per range key (a range on two cards: the newest
 * folder). `stale`: built for other model files, it needs a rebuild (trtRangeDirs).
 */
// loop: NOT-WORTH — a few range folders' files and one small record each, after a build, a job, a move or a removal
export async function rangesOnDisk(
  root: string,
  stamps: ReadonlyMap<string, string> | null,
  bytesOf: (dir: string) => Promise<number>,
): Promise<{ range: string; bytes: number; buildSeconds: number | null; stale: boolean }[]> {
  const out = new Map<string, { range: string; bytes: number; buildSeconds: number | null; stale: boolean; at: number }>();
  // loop: NOT-WORTH — a few ranges
  for (const r of (await trtRangeDirs(root, stamps)).filter((x) => x.built || x.stale)) {
    let buildSeconds: number | null = null;
    try {
      // loop: NOT-WORTH — one small async file read per range
      const rec = JSON.parse(await readFile(join(r.dir, BUILD_RECORD), "utf8")) as { seconds?: unknown };
      if (typeof rec.seconds === "number" && rec.seconds > 0) buildSeconds = rec.seconds;
    } catch {
      // error: NOT-WORTH — no record (built before the app recorded times, or by a job): "not measured"
    }
    // loop: NOT-WORTH — one async stat per range
    const at = (await stat(r.dir).catch(() => null))?.mtimeMs ?? 0;
    const was = out.get(r.range);
    // a range built on one card and stale on another: the built one
    if (!was || (r.built && was.stale) || (r.stale === was.stale && at > was.at)) out.set(r.range, { range: r.range, bytes: await bytesOf(r.dir), buildSeconds, stale: r.stale, at });
  }
  return (
    [...out.values()]
      // loop: NOT-WORTH — as above
      .map(({ range, bytes, buildSeconds, stale }) => ({ range, bytes, buildSeconds, stale }))
      // loop: NOT-WORTH — as above
      .sort((a, b) => a.range.localeCompare(b.range))
  );
}

/** Records how long the app's build of `range` took, in its newest folder (the card it was just built for). */
export async function recordBuild(root: string, range: string, seconds: number): Promise<void> {
  const dirs: { dir: string; mtime: number }[] = [];
  // loop: NOT-WORTH — a few range folders, one async stat each, once per build
  for (const r of (await trtRangeDirs(root)).filter((x) => x.range === range)) dirs.push({ dir: r.dir, mtime: (await stat(r.dir).catch(() => null))?.mtimeMs ?? 0 });
  // loop: NOT-WORTH — as above
  const newest = dirs.sort((a, b) => a.mtime - b.mtime).at(-1);
  if (!newest) return;
  try {
    // loop: NOT-WORTH — one small async write per build
    await writeFile(join(newest.dir, BUILD_RECORD), JSON.stringify({ seconds, at: new Date().toISOString() }));
  } catch {
    // error: NOT-WORTH — the row then says "build time not recorded"; the build itself is fine
  }
}

/** Removes every built range of a size (all windows, all cards). */
export async function removeSize(root: string, sizeKey: string): Promise<void> {
  // loop: NOT-WORTH — a few range folders, per user removal
  for (const r of (await trtRangeDirs(root)).filter((x) => x.range.startsWith(`${sizeKey}_t`))) {
    // loop: NOT-WORTH — one range folder (five networks' engines) per removal (async), after the user's confirmation
    await rm(r.dir, { recursive: true, force: true });
  }
}

export interface PrebuildDeps {
  makeEngine(onReply: (r: EngineReply) => void, onExit: (code: number | null, signal: NodeJS.Signals | null, stderrTail: string[]) => void): EngineHandle;
  changed(): void;
  // whether it may run at all: the setting on, the parts installed, the Rust engine, no cache move
  allowed(): boolean;
  // the queue runs (it has the card): a build that may run waits for it (paused) and goes on when it stops
  queueRunning?(): boolean;
  // the other programs using the graphics card (names), checked before a start the user didn't ask for
  othersOnGpu(): Promise<string[]>;
  // the built range keys, as last read from the cache
  built(): string[];
  // reads the cache again (async: the cache folder can be on a network share), before a start looks at built()
  reread?(): Promise<void>;
  // the sizes to build (the setting; one per range, each inside TensorRT's ranges)
  sizes(): readonly TrtSize[];
  // a range the app just built, and the seconds its networks took (the engine's built_s): its build time on screen
  recordBuild?(range: string, seconds: number): void;
  now?: () => number;
  // how often a build held back by another program on the card looks again (default a minute)
  recheckMs?: number;
}

/** A range's id in the engine messages: its size range ("trt-h1024-1280_w1792-2176"), one per chosen size. */
export const rangeId = (r: { width: number; height: number }) => `trt-${trtSizeKey(r.width, r.height)}`;

// `again`: size keys a job asked to build (buildSize), built even where a range of that size is (for shorter windows)
const fresh = (built: readonly string[], sizes: readonly TrtSize[], again: ReadonlySet<string> = new Set()): PrebuildRange[] =>
  sizes
    // loop: NOT-WORTH — the few chosen sizes
    .filter((s) => trtSizeKey(s.width, s.height) !== null)
    // loop: NOT-WORTH — as above
    .map((s) => {
      const key = trtSizeKey(s.width, s.height);
      // loop: NOT-WORTH — a few built ranges
      const done = !again.has(key!) && built.some((k) => k.startsWith(`${key}_t`));
      return { label: s.label, width: s.width, height: s.height, state: done ? "done" : "todo", piece: null, range: null, fallbacks: {}, error: null };
    });

export class Prebuilder {
  state: TrtPrebuild;
  private proc: EngineHandle | null = null;
  // the engine pause() / stop() killed or the build's end quit, until it has exited
  private ending: EngineHandle | null = null;
  // an automatic start reading the graphics card (othersOnGpu)
  private checking = false;
  // Build now pressed while that reading ran: the start that reads goes ahead whatever it finds
  private askedWhileChecking = false;
  // the next look at the card while another program uses it (blocked)
  private recheck: ReturnType<typeof setTimeout> | null = null;
  private now: () => number;
  // the sizes a job's Build it now asked for (size keys), until their build ends
  private again = new Set<string>();
  // the other programs on the card when the running build started (othersOnGpu)
  private othersAtStart: string[] = [];

  constructor(private readonly deps: PrebuildDeps) {
    this.now = deps.now ?? Date.now;
    const ranges = fresh(deps.built(), deps.sizes());
    // loop: NOT-WORTH — the few chosen sizes
    this.state = { status: ranges.every((r) => r.state === "done") ? "done" : "idle", ranges, startedAt: null, note: null };
  }

  get running(): boolean {
    return this.proc !== null;
  }

  /** The engine pause() or stop() killed hasn't exited yet (its graphics memory may still be held). */
  get engineEnding(): boolean {
    return this.ending?.running ?? false;
  }

  /**
   * Read what is built and chosen again (after a job, a cache move, a removal, a size chosen). While a build runs,
   * only the list changes: a size chosen meanwhile is built after the others, a range built or building keeps its state.
   */
  refresh(): void {
    const next = fresh(this.deps.built(), this.deps.sizes(), this.again);
    if (this.proc) {
      // loop: NOT-WORTH — the few chosen sizes, and the few in the list
      // (a size a job asked to build again, found built in the cache but not built by this run, is built after the others)
      const ranges = next.map((n) => this.state.ranges.find((r) => rangeId(r) === rangeId(n) && r.state !== "todo" && !(n.state === "todo" && r.state === "done" && r.range === null)) ?? n);
      this.state = { ...this.state, ranges };
      return;
    }
    // a failed build stays failed until the user (or the next start) builds again: its reason stays on screen
    // (review 2026-10-29 N1; an older range of its size made it "done" again after the next job)
    // loop: NOT-WORTH — the few chosen sizes, and the few in the list
    const ranges = next.map((n) => this.state.ranges.find((r) => rangeId(r) === rangeId(n) && r.state === "failed") ?? n);
    // loop: NOT-WORTH — the few chosen sizes
    const allDone = ranges.every((r) => r.state === "done");
    const status = allDone ? "done" : this.state.status === "done" ? "idle" : this.state.status;
    this.state = { ...this.state, status, ranges };
  }

  /**
   * Build what isn't built. `asked`: the user pressed Build now (it then starts while other programs use the card);
   * otherwise (the switch, the download's end, the queue's end, a size ticked) it waits for a free card and looks
   * again every minute, so it starts by itself once Sonata (or another program) lets go of the card.
   */
  async start(asked: boolean): Promise<void> {
    this.clearRecheck();
    if (this.checking && asked) this.askedWhileChecking = true;
    if (this.proc || this.checking || !this.deps.allowed()) return;
    // one check at a time (the reread, then the look at the card): the queue's changes call this often
    this.askedWhileChecking = false;
    if (this.deps.reread) {
      this.checking = true;
      await this.deps.reread().finally(() => (this.checking = false));
      if (this.proc || !this.deps.allowed()) return;
    }
    this.refresh();
    // loop: NOT-WORTH — the few chosen sizes
    if (this.state.ranges.every((r) => r.state === "done")) return this.set({ status: "done", note: null });
    // the queue has the card (TensorRT's download ended, the switch or Build now while keying): it goes on after the queue
    if (this.deps.queueRunning?.()) return this.waitForQueue();
    // who else uses the card as it starts: a build the user asked for isn't held back by them, but a failure's reason
    // says whether they were there (review 2026-10-29 N-N5)
    this.checking = true;
    const others = await this.deps.othersOnGpu().finally(() => (this.checking = false));
    if (this.proc || !this.deps.allowed()) return;
    if (this.deps.queueRunning?.()) return this.waitForQueue();
    this.othersAtStart = others;
    if (!asked && !this.askedWhileChecking) {
      if (others.length > 0) {
        // loop: NOT-WORTH — one look a minute while blocked, one timer at a time (cleared by start, pause and stop)
        this.recheck = setTimeout(() => {
          this.recheck = null;
          if (this.state.status === "blocked") void this.start(false);
        }, this.deps.recheckMs ?? 60_000);
        return this.set({ status: "blocked", note: `${others.join(", ")} ${others.length > 1 ? "are" : "is"} using the graphics card` });
      }
    }
    // loop: NOT-WORTH — the few chosen sizes
    for (const r of this.state.ranges) if (r.state === "failed") Object.assign(r, { state: "todo", error: null, cardWasFree: false });
    const proc = this.deps.makeEngine(
      (r) => this.reply(proc, r),
      (code, signal) => this.exited(proc, code, signal),
    );
    this.proc = proc;
    this.set({ status: "running", startedAt: this.now(), note: null });
    try {
      await proc.start();
    } catch (e) {
      // error: SHOWN — the TensorRT section says the build couldn't start, and why
      if (this.proc !== proc) return;
      this.proc = null;
      return this.set({ status: "error", startedAt: null, note: `${ENGINE_FAILED}: ${(e as Error).message}` });
    }
    if (this.proc === proc) this.next();
  }

  /**
   * A job's Build it now (1.0.0-dev.7): build this size (a chosen one, `sizeKey`) as Build now does, also where a range
   * of it is built already (for shorter windows, before builds covered the card): the engine builds the range that
   * covers every window a job on this card picks, or answers at once that it is built.
   */
  buildSize(sizeKey: string): Promise<void> {
    this.again.add(sizeKey);
    this.refresh();
    return this.start(true);
  }

  /**
   * Every chosen size covers this card (Marcy 2026-10-29: "it should just build for all scenarios"): a size counts as
   * built only once the engine says its range covers every window a job on this card picks; a range built for shorter
   * windows (an older version, or a build while the card was busy) is built again, in the background, by itself.
   */
  coverCard(sizeKeys: readonly string[], now = false): Promise<void> {
    // loop: NOT-WORTH — the few chosen sizes, at start
    for (const k of sizeKeys) this.again.add(k);
    this.refresh();
    return this.start(now);
  }

  /** The queue starts: the build gives way (the engine is killed; it goes on when the queue stops). */
  pause(): void {
    const was = this.state.status;
    this.clearRecheck();
    // one held back by another program on the card waits too: its next look is after the queue (the look a minute is off)
    if (this.kill() || was === "blocked") this.set({ status: "paused", startedAt: null, note: null });
  }

  /** The user's Stop (or TensorRT switched off): the build ends; Build now goes on where it stopped. */
  stop(): void {
    const was = this.state.status;
    this.clearRecheck();
    this.kill();
    if (was === "running" || was === "paused" || was === "blocked") this.set({ status: "stopped", startedAt: null, note: null });
  }

  /**
   * The build stops for a change in the cache (a size removed, the cache folder moved or cleared). The returned function
   * lets a build that was running, waiting for the queue or held back by another program go on afterwards.
   */
  suspend(): () => void {
    const was = this.state.status;
    this.stop();
    return () => {
      if (was === "running" || was === "paused" || was === "blocked") void this.start(false);
    };
  }

  /** The queue runs: the build waits for it (and goes on by itself when it stops). */
  waitForQueue(): void {
    if (this.proc || this.state.status === "done") return;
    this.set({ status: "paused", startedAt: null, note: null });
  }

  /** The queue stopped: a paused build goes on. */
  queueStopped(): void {
    if (this.state.status === "paused") void this.start(false);
  }

  private clearRecheck(): void {
    if (this.recheck) clearTimeout(this.recheck);
    this.recheck = null;
  }

  private kill(): boolean {
    const proc = this.proc;
    if (!proc) return false;
    this.proc = null;
    this.ending = proc;
    proc.kill();
    // loop: NOT-WORTH — the few chosen sizes
    for (const r of this.state.ranges) if (r.state === "building") Object.assign(r, { state: "todo", piece: null });
    return true;
  }

  private next(): void {
    // loop: NOT-WORTH — the few chosen sizes
    const r = this.state.ranges.find((x) => x.state === "todo");
    if (!r) {
      // ending until it has exited: it still holds the card's memory while it quits
      this.ending = this.proc;
      this.proc?.quit();
      this.proc = null;
      // loop: NOT-WORTH — the few chosen sizes
      const failed = this.state.ranges.filter((x) => x.state === "failed");
      // loop: NOT-WORTH — as above
      const note = failed.length ? failed.map((x) => `${x.label}: ${x.error}`).join("; ") : null;
      return this.set({ status: failed.length ? "error" : "done", startedAt: null, note });
    }
    Object.assign(r, { state: "building", piece: null, error: null });
    this.proc!.send({ cmd: "trt_build", id: rangeId(r), width: r.width, height: r.height });
    this.set({});
  }

  private reply(proc: EngineHandle, m: EngineReply): void {
    if (proc !== this.proc) return;
    // loop: NOT-WORTH — the few chosen sizes
    const r = this.state.ranges.find((x) => rangeId(x) === m.id);
    if (!r || r.state !== "building") return;
    if (m.type === "progress" && m.stage === "optimize" && typeof m.piece === "string") {
      Object.assign(r, { piece: m.piece });
      return this.set({});
    }
    if (m.type === "trt_built") {
      const fallbacks: Record<string, string> = {};
      // loop: NOT-WORTH — at most five networks
      for (const [k, why] of Object.entries((m.fallbacks ?? {}) as Record<string, unknown>)) fallbacks[k] = String(why);
      Object.assign(r, { state: "done", piece: null, range: typeof m.range === "string" ? m.range : null, fallbacks });
      this.again.delete(trtSizeKey(r.width, r.height)!);
      // what the five networks' builds took here, recorded only when this run built all five (a build resumed after a
      // pause, or one that reused networks, isn't the whole time)
      const built = (m.built_s ?? {}) as Record<string, unknown>;
      // loop: NOT-WORTH — five networks
      if (r.range && m.reused !== true && TRT_PIECES.every((p) => typeof built[p] === "number"))
        // loop: NOT-WORTH — as above
        this.deps.recordBuild?.(
          r.range,
          TRT_PIECES.reduce((n, p) => n + (built[p] as number), 0),
        );
      return this.next();
    }
    if (m.type === "error") {
      // short of memory with no other program on the card: building again would meet the same card, so no retry is
      // offered for it (review 2026-10-29 N-N5); with one there, it names them
      const short = m.code === "oom";
      const alone = short && this.othersAtStart.length === 0;
      const who = short && !alone ? ` (${this.othersAtStart.join(", ")} ${this.othersAtStart.length > 1 ? "were" : "was"} using the graphics card when it started)` : "";
      Object.assign(r, { state: "failed", piece: null, error: `${String(m.message ?? m.code)}${who}`, cardWasFree: alone });
      this.again.delete(trtSizeKey(r.width, r.height)!);
      return this.next();
    }
  }

  private exited(proc: EngineHandle, code: number | null, signal: NodeJS.Signals | null): void {
    if (proc !== this.proc) return; // killed by pause / stop, or finished
    this.proc = null;
    // loop: NOT-WORTH — the few chosen sizes
    for (const r of this.state.ranges) if (r.state === "building") Object.assign(r, { state: "failed", piece: null, error: "the engine stopped" });
    this.set({ status: "error", startedAt: null, note: `The engine stopped while building (${signal ?? `exit ${code}`})` });
  }

  private set(p: Partial<TrtPrebuild>): void {
    this.state = { ...this.state, ...p, ranges: [...this.state.ranges] };
    this.deps.changed();
  }
}
