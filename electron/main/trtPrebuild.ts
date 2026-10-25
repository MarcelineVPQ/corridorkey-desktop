// The background TensorRT build (Marcy, 2026-10-25: "a job must never sit in a TensorRT build again"). When TensorRT
// is switched on, and when its download finishes, the app builds the common ranges once, ahead of any job: 4K
// (4096x2160) and HD (1920x1080), with the engine's own `trt_build` (the same window a job picks, the same builder,
// docs/ENGINE_PROTOCOL.md). Jobs send `tensorrt_build: false`, so until a range is built its clips run on CUDA.
//
// lifetime (rule 11): a short-lived engine of its own, only while no queue runs: the queue's start pauses it (the
// engine is killed, the builder dies with it) and its end resumes it (what was built is kept; a half-built network is
// built again). Not started by itself while other programs use the graphics card (Sonata); Build now starts it anyway.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { EngineReply } from "./engine";
import type { EngineHandle } from "./queue";
import type { PrebuildRange, TrtPrebuild } from "../../src/shared/types";
import { buildFraction, trtSizeKey, TRT_PIECES } from "../../src/shared/trt";

/** What the app builds ahead: 4K first (the minutes a 4K job would wait), then HD. */
export const PREBUILD_SIZES: readonly { label: string; width: number; height: number }[] = [
  { label: "4K", width: 4096, height: 2160 },
  { label: "HD", width: 1920, height: 1080 },
];

/**
 * Every range folder in the TensorRT cache (`<root>/<card>/<range>`, engine tensorrt.rs cache_dir) and whether it is
 * built: each network has its engine's stub (`<piece>_ctx.onnx`, written after a build succeeds) or a remembered
 * failed build (`<piece>.failed`, that network runs on CUDA).
 */
// loop: NOT-WORTH — a few readdirs and stats of the TensorRT cache, after a build, a job, a move or a removal (never per state push)
export function trtRangeDirs(root: string, list: (p: string) => string[] = (p) => readdirSync(p), exists: (p: string) => boolean = existsSync): { range: string; dir: string; built: boolean }[] {
  const dirs = (p: string) => {
    try {
      return list(p);
    } catch {
      // error: NOT-WORTH — no TensorRT engines built (the folder isn't there)
      return [];
    }
  };
  const out: { range: string; dir: string; built: boolean }[] = [];
  // loop: NOT-WORTH — one folder per card / driver (one or two), when the app reads what is built
  for (const card of dirs(root)) {
    // loop: NOT-WORTH — a few ranges per card
    for (const range of dirs(join(root, card)).filter((n) => /^h\d+-\d+_w\d+-\d+_t/.test(n))) {
      const dir = join(root, card, range);
      // loop: NOT-WORTH — five networks
      const built = TRT_PIECES.every((p) => exists(join(dir, p, `${p}_ctx.onnx`)) || exists(join(dir, p, `${p}.failed`)));
      out.push({ range, dir, built });
    }
  }
  return out;
}

/** The built ranges' keys (what the waiting clip's line and the Engine page name). */
export function builtRanges(root: string): string[] {
  // loop: NOT-WORTH — a few ranges, when the app reads what is built
  return [
    ...new Set(
      trtRangeDirs(root)
        .filter((r) => r.built)
        .map((r) => r.range),
    ),
  ].sort();
}

export interface PrebuildDeps {
  makeEngine(onReply: (r: EngineReply) => void, onExit: (code: number | null, signal: NodeJS.Signals | null, stderrTail: string[]) => void): EngineHandle;
  changed(): void;
  // whether it may run now: the setting on, the parts installed, the Rust engine, no queue running
  allowed(): boolean;
  // the other programs using the graphics card (names), checked before a start the user didn't ask for
  othersOnGpu(): Promise<string[]>;
  // the built range keys, read from the cache
  built(): string[];
  now?: () => number;
}

const fresh = (built: readonly string[]): PrebuildRange[] =>
  // loop: NOT-WORTH — two sizes
  PREBUILD_SIZES.map((s) => {
    const key = trtSizeKey(s.width, s.height);
    // loop: NOT-WORTH — a few built ranges
    const done = key !== null && built.some((k) => k.startsWith(`${key}_t`));
    return { ...s, state: done ? "done" : "todo", piece: null, fraction: done ? 1 : 0, range: null, fallbacks: {}, error: null };
  });

/** All ranges' fraction done: one share per range, the building one by its own fraction. */
export function overallFraction(ranges: readonly PrebuildRange[]): number {
  if (ranges.length === 0) return 0;
  // loop: NOT-WORTH — two ranges
  return ranges.reduce((s, r) => s + (r.state === "done" ? 1 : r.state === "building" ? r.fraction : 0), 0) / ranges.length;
}

export class Prebuilder {
  state: TrtPrebuild;
  private proc: EngineHandle | null = null;
  // an automatic start reading the graphics card (othersOnGpu)
  private checking = false;
  private now: () => number;

  constructor(private readonly deps: PrebuildDeps) {
    this.now = deps.now ?? Date.now;
    const ranges = fresh(deps.built());
    // loop: NOT-WORTH — two ranges
    this.state = { status: ranges.every((r) => r.state === "done") ? "done" : "idle", ranges, fraction: overallFraction(ranges), startedAt: null, note: null };
  }

  get running(): boolean {
    return this.proc !== null;
  }

  /** Read what is built again (after a job, a cache move, a removal), unless a build runs. */
  refresh(): void {
    if (this.proc) return;
    const ranges = fresh(this.deps.built());
    // loop: NOT-WORTH — two ranges
    const allDone = ranges.every((r) => r.state === "done");
    const status = allDone ? "done" : this.state.status === "done" ? "idle" : this.state.status;
    this.state = { ...this.state, status, ranges, fraction: overallFraction(ranges) };
  }

  /**
   * Build what isn't built. `asked`: the user pressed Build now (it then starts while other programs use the card);
   * otherwise (the switch, the download's end, the queue's end) it waits for a free card.
   */
  async start(asked: boolean): Promise<void> {
    if (this.proc || this.checking || !this.deps.allowed()) return;
    this.refresh();
    // loop: NOT-WORTH — two ranges
    if (this.state.ranges.every((r) => r.state === "done")) return this.set({ status: "done", note: null });
    if (!asked) {
      // one check at a time: the queue's changes call this often while a build is paused
      this.checking = true;
      const others = await this.deps.othersOnGpu().finally(() => (this.checking = false));
      if (others.length > 0) return this.set({ status: "blocked", note: `${others.join(", ")} ${others.length > 1 ? "are" : "is"} using the graphics card` });
      if (this.proc || !this.deps.allowed()) return;
    }
    // loop: NOT-WORTH — two ranges
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
      return this.set({ status: "error", startedAt: null, note: `The engine didn't start: ${(e as Error).message}` });
    }
    if (this.proc === proc) this.next();
  }

  /** The queue starts: the build gives way (the engine is killed; it goes on when the queue stops). */
  pause(): void {
    if (!this.kill()) return;
    this.set({ status: "paused", startedAt: null, note: null });
  }

  /** The user's Stop (or TensorRT switched off): the build ends; Build now goes on where it stopped. */
  stop(): void {
    const was = this.state.status;
    this.kill();
    if (was === "running" || was === "paused" || was === "blocked") this.set({ status: "stopped", startedAt: null, note: null });
  }

  /** The queue stopped: a paused build goes on. */
  queueStopped(): void {
    if (this.state.status === "paused") void this.start(false);
  }

  private kill(): boolean {
    const proc = this.proc;
    if (!proc) return false;
    this.proc = null;
    proc.kill();
    // loop: NOT-WORTH — two ranges
    for (const r of this.state.ranges) if (r.state === "building") Object.assign(r, { state: "todo", piece: null, fraction: 0 });
    this.state.fraction = overallFraction(this.state.ranges);
    return true;
  }

  private next(): void {
    // loop: NOT-WORTH — two ranges
    const r = this.state.ranges.find((x) => x.state === "todo");
    if (!r) {
      this.proc?.quit();
      this.proc = null;
      // loop: NOT-WORTH — two ranges
      const failed = this.state.ranges.filter((x) => x.state === "failed");
      // loop: NOT-WORTH — as above
      const note = failed.length ? failed.map((x) => `${x.label}: ${x.error}`).join("; ") : null;
      return this.set({ status: failed.length ? "error" : "done", startedAt: null, note });
    }
    Object.assign(r, { state: "building", piece: null, fraction: 0, error: null });
    this.proc!.send({ cmd: "trt_build", id: `trt-${r.label}`, width: r.width, height: r.height });
    this.set({});
  }

  private reply(proc: EngineHandle, m: EngineReply): void {
    if (proc !== this.proc) return;
    // loop: NOT-WORTH — two ranges
    const r = this.state.ranges.find((x) => `trt-${x.label}` === m.id);
    if (!r || r.state !== "building") return;
    if (m.type === "progress" && m.stage === "optimize" && typeof m.piece === "string") {
      // the 4K weights are measured (README, Speed, 0.0.7-dev); other sizes count one share per network
      Object.assign(r, { piece: m.piece, fraction: buildFraction(m.piece, r.label === "4K") });
      return this.set({});
    }
    if (m.type === "trt_built") {
      const fallbacks: Record<string, string> = {};
      // loop: NOT-WORTH — at most five networks
      for (const [k, why] of Object.entries((m.fallbacks ?? {}) as Record<string, unknown>)) fallbacks[k] = String(why);
      Object.assign(r, { state: "done", piece: null, fraction: 1, range: typeof m.range === "string" ? m.range : null, fallbacks });
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
    // loop: NOT-WORTH — two ranges
    for (const r of this.state.ranges) if (r.state === "building") Object.assign(r, { state: "failed", piece: null, fraction: 0, error: "the engine stopped" });
    this.set({ status: "error", startedAt: null, note: `The engine stopped while building (${signal ?? `exit ${code}`})` });
  }

  private set(p: Partial<TrtPrebuild>): void {
    this.state = { ...this.state, ...p, ranges: [...this.state.ranges], fraction: overallFraction(this.state.ranges) };
    this.deps.changed();
  }
}
