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
import { join } from "node:path";
import type { EngineReply } from "./engine";
import type { EngineHandle } from "./queue";
import type { PrebuildRange, TrtPrebuild } from "../../src/shared/types";
import { buildFraction, trtSizeKey, TRT_PIECES, type TrtSize } from "../../src/shared/trt";
import { ENGINE_FAILED } from "../../src/shared/texts";

// the 4K range, whose network build times are measured (README, Speed, 0.0.7-dev): its bar moves by them
const KEY_4K = trtSizeKey(4096, 2160);

const existsAsync = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/**
 * Every range folder in the TensorRT cache (`<root>/<card>/<range>`, engine tensorrt.rs cache_dir) and whether it is
 * built: each network has its engine's stub (`<piece>_ctx.onnx`, written after a build succeeds) or a remembered
 * failed build (`<piece>.failed`, that network runs on CUDA). Async: the cache folder can be on a network share.
 */
// loop: NOT-WORTH — a few async readdirs and stats of the TensorRT cache, after a build, a job, a move or a removal (never per state push)
export async function trtRangeDirs(
  root: string,
  list: (p: string) => Promise<string[]> = (p) => readdir(p),
  exists: (p: string) => Promise<boolean> = existsAsync,
): Promise<{ range: string; dir: string; built: boolean }[]> {
  const dirs = (p: string) =>
    list(p).catch(
      // error: NOT-WORTH — no TensorRT engines built (the folder isn't there)
      () => [] as string[],
    );
  const out: { range: string; dir: string; built: boolean }[] = [];
  // loop: NOT-WORTH — one folder per card / driver (one or two), when the app reads what is built
  for (const card of await dirs(root)) {
    // loop: NOT-WORTH — a few ranges per card
    for (const range of (await dirs(join(root, card))).filter((n) => /^h\d+-\d+_w\d+-\d+_t/.test(n))) {
      const dir = join(root, card, range);
      let built = true;
      // loop: NOT-WORTH — five networks, one or two async stats each
      for (const p of TRT_PIECES) if (!(await exists(join(dir, p, `${p}_ctx.onnx`))) && !(await exists(join(dir, p, `${p}.failed`)))) built = false;
      out.push({ range, dir, built });
    }
  }
  return out;
}

/** The built ranges' keys (what the waiting clip's line and the Engine page name). */
export async function builtRanges(root: string): Promise<string[]> {
  // loop: NOT-WORTH — a few ranges, when the app reads what is built
  return [...new Set((await trtRangeDirs(root)).filter((r) => r.built).map((r) => r.range))].sort();
}

/** The app's record of a range it built (in the range's folder; the engine ignores it): how long the build took here. */
export const BUILD_RECORD = ".corridorkey-build.json";

/** A built range's size on disk and recorded build time, per range key (a range on two cards: the newest folder). */
// loop: NOT-WORTH — a few range folders' files and one small record each, after a build, a job, a move or a removal
export async function rangesOnDisk(root: string, bytesOf: (dir: string) => Promise<number>): Promise<{ range: string; bytes: number; buildSeconds: number | null }[]> {
  const out = new Map<string, { range: string; bytes: number; buildSeconds: number | null; at: number }>();
  // loop: NOT-WORTH — a few ranges
  for (const r of (await trtRangeDirs(root)).filter((x) => x.built)) {
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
    if (!was || at > was.at) out.set(r.range, { range: r.range, bytes: await bytesOf(r.dir), buildSeconds, at });
  }
  return (
    [...out.values()]
      // loop: NOT-WORTH — as above
      .map(({ range, bytes, buildSeconds }) => ({ range, bytes, buildSeconds }))
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

const fresh = (built: readonly string[], sizes: readonly TrtSize[]): PrebuildRange[] =>
  sizes
    // loop: NOT-WORTH — the few chosen sizes
    .filter((s) => trtSizeKey(s.width, s.height) !== null)
    // loop: NOT-WORTH — as above
    .map((s) => {
      const key = trtSizeKey(s.width, s.height);
      // loop: NOT-WORTH — a few built ranges
      const done = built.some((k) => k.startsWith(`${key}_t`));
      return { label: s.label, width: s.width, height: s.height, state: done ? "done" : "todo", piece: null, fraction: done ? 1 : 0, range: null, fallbacks: {}, error: null };
    });

/** All ranges' fraction done: one share per range, the building one by its own fraction. */
export function overallFraction(ranges: readonly PrebuildRange[]): number {
  if (ranges.length === 0) return 0;
  // loop: NOT-WORTH — the few chosen sizes
  return ranges.reduce((s, r) => s + (r.state === "done" ? 1 : r.state === "building" ? r.fraction : 0), 0) / ranges.length;
}

export class Prebuilder {
  state: TrtPrebuild;
  private proc: EngineHandle | null = null;
  // an automatic start reading the graphics card (othersOnGpu)
  private checking = false;
  // Build now pressed while that reading ran: the start that reads goes ahead whatever it finds
  private askedWhileChecking = false;
  // the next look at the card while another program uses it (blocked)
  private recheck: ReturnType<typeof setTimeout> | null = null;
  private now: () => number;

  constructor(private readonly deps: PrebuildDeps) {
    this.now = deps.now ?? Date.now;
    const ranges = fresh(deps.built(), deps.sizes());
    // loop: NOT-WORTH — the few chosen sizes
    this.state = { status: ranges.every((r) => r.state === "done") ? "done" : "idle", ranges, fraction: overallFraction(ranges), startedAt: null, note: null };
  }

  get running(): boolean {
    return this.proc !== null;
  }

  /**
   * Read what is built and chosen again (after a job, a cache move, a removal, a size chosen). While a build runs,
   * only the list changes: a size chosen meanwhile is built after the others, a range built or building keeps its state.
   */
  refresh(): void {
    const next = fresh(this.deps.built(), this.deps.sizes());
    if (this.proc) {
      // loop: NOT-WORTH — the few chosen sizes, and the few in the list
      const ranges = next.map((n) => this.state.ranges.find((r) => rangeId(r) === rangeId(n) && r.state !== "todo") ?? n);
      this.state = { ...this.state, ranges, fraction: overallFraction(ranges) };
      return;
    }
    const ranges = next;
    // loop: NOT-WORTH — the few chosen sizes
    const allDone = ranges.every((r) => r.state === "done");
    const status = allDone ? "done" : this.state.status === "done" ? "idle" : this.state.status;
    this.state = { ...this.state, status, ranges, fraction: overallFraction(ranges) };
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
    if (!asked && !this.askedWhileChecking) {
      this.checking = true;
      const others = await this.deps.othersOnGpu().finally(() => (this.checking = false));
      if (this.proc || !this.deps.allowed()) return;
      if (this.deps.queueRunning?.()) return this.waitForQueue();
      if (others.length > 0 && !this.askedWhileChecking) {
        // loop: NOT-WORTH — one look a minute while blocked, one timer at a time (cleared by start, pause and stop)
        this.recheck = setTimeout(() => {
          this.recheck = null;
          if (this.state.status === "blocked") void this.start(false);
        }, this.deps.recheckMs ?? 60_000);
        return this.set({ status: "blocked", note: `${others.join(", ")} ${others.length > 1 ? "are" : "is"} using the graphics card` });
      }
    }
    // loop: NOT-WORTH — the few chosen sizes
    for (const r of this.state.ranges) if (r.state === "failed") Object.assign(r, { state: "todo", error: null });
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
    proc.kill();
    // loop: NOT-WORTH — the few chosen sizes
    for (const r of this.state.ranges) if (r.state === "building") Object.assign(r, { state: "todo", piece: null, fraction: 0 });
    this.state.fraction = overallFraction(this.state.ranges);
    return true;
  }

  private next(): void {
    // loop: NOT-WORTH — the few chosen sizes
    const r = this.state.ranges.find((x) => x.state === "todo");
    if (!r) {
      this.proc?.quit();
      this.proc = null;
      // loop: NOT-WORTH — the few chosen sizes
      const failed = this.state.ranges.filter((x) => x.state === "failed");
      // loop: NOT-WORTH — as above
      const note = failed.length ? failed.map((x) => `${x.label}: ${x.error}`).join("; ") : null;
      return this.set({ status: failed.length ? "error" : "done", startedAt: null, note });
    }
    Object.assign(r, { state: "building", piece: null, fraction: 0, error: null });
    this.proc!.send({ cmd: "trt_build", id: rangeId(r), width: r.width, height: r.height });
    this.set({});
  }

  private reply(proc: EngineHandle, m: EngineReply): void {
    if (proc !== this.proc) return;
    // loop: NOT-WORTH — the few chosen sizes
    const r = this.state.ranges.find((x) => rangeId(x) === m.id);
    if (!r || r.state !== "building") return;
    if (m.type === "progress" && m.stage === "optimize" && typeof m.piece === "string") {
      // the 4K weights are measured (README, Speed, 0.0.7-dev); other sizes count one share per network
      Object.assign(r, { piece: m.piece, fraction: buildFraction(m.piece, trtSizeKey(r.width, r.height) === KEY_4K) });
      return this.set({});
    }
    if (m.type === "trt_built") {
      const fallbacks: Record<string, string> = {};
      // loop: NOT-WORTH — at most five networks
      for (const [k, why] of Object.entries((m.fallbacks ?? {}) as Record<string, unknown>)) fallbacks[k] = String(why);
      Object.assign(r, { state: "done", piece: null, fraction: 1, range: typeof m.range === "string" ? m.range : null, fallbacks });
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
      Object.assign(r, { state: "failed", piece: null, fraction: 0, error: String(m.message ?? m.code) });
      return this.next();
    }
  }

  private exited(proc: EngineHandle, code: number | null, signal: NodeJS.Signals | null): void {
    if (proc !== this.proc) return; // killed by pause / stop, or finished
    this.proc = null;
    // loop: NOT-WORTH — the few chosen sizes
    for (const r of this.state.ranges) if (r.state === "building") Object.assign(r, { state: "failed", piece: null, fraction: 0, error: "the engine stopped" });
    this.set({ status: "error", startedAt: null, note: `The engine stopped while building (${signal ?? `exit ${code}`})` });
  }

  private set(p: Partial<TrtPrebuild>): void {
    this.state = { ...this.state, ...p, ranges: [...this.state.ranges], fraction: overallFraction(this.state.ranges) };
    this.deps.changed();
  }
}
