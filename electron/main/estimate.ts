// The graphics-memory estimate for the manual window picker (backlog row 41). The number is the engine's own
// (its `estimate` command: the same peak estimate its automatic window uses, against the free memory it reads);
// nothing here computes one (rule 1).
//
// lifetime (rule 11): the queue's engine is busy while the queue runs, so the estimate asks a short-lived engine of
// its own, only while no queue runs: spawned, pinged, asked once for every manual window of the clip, sent `quit`.
// Measured 2026-10-24 (RTX 5080, Linux): start to pong 0.15 s; it loads no model and makes no CUDA context, so it
// holds no graphics memory. One at a time; the queue's start stops it (index.ts).
import type { EngineReply } from "./engine";
import type { EngineHandle } from "./queue";
import { MANUAL_WINDOWS, type MemoryEstimate, type MemoryEstimateResult, type WindowEstimate } from "../../src/shared/types";

// the engine answers in well under a second (ffprobe on a local file); a stalled mount gets this long, then a kill
export const ESTIMATE_TIMEOUT_MS = 30_000;
// a clip asked again within this long gets the same reading (the panel re-renders; the free memory moves slowly)
export const ESTIMATE_FRESH_MS = 15_000;
// readings kept (one per clip and limit); the oldest goes first
const CACHE_MAX = 32;

export interface EstimatorDeps {
  makeEngine(onReply: (r: EngineReply) => void, onExit: (code: number | null, signal: NodeJS.Signals | null, stderrTail: string[]) => void): EngineHandle;
  now?: () => number;
}

/**
 * The `estimate` request: every manual window, in normal and in low-memory mode. `limitGb`: the clip's graphics
 * memory limit (backlog row 43), sent as the run sends it, so the verdicts are weighed against the same budget;
 * `modelScale`: the clip's internal resolution (backlog row 42), sent only when it isn't full.
 */
export function estimateRequest(id: string, input: string, limitGb: number | null = null, modelScale = 1): Record<string, unknown> {
  // loop: NOT-WORTH — six windows, once per estimate
  const req: Record<string, unknown> = { cmd: "estimate", id, input, windows: MANUAL_WINDOWS.flatMap(([c, s]) => [[c, s, false] as const, [c, s, true] as const]) };
  if (limitGb !== null) req.vram_budget_gb = limitGb;
  if (modelScale !== 1) req.model_scale = modelScale;
  return req;
}

/** One reading per clip, limit and internal resolution. */
const cacheKey = (input: string, limitGb: number | null, modelScale: number) => `${limitGb ?? "auto"}|${modelScale}|${input}`;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The engine's `estimate` reply as the page shows it; null when it isn't one. */
export function parseEstimate(r: EngineReply, at: number): MemoryEstimate | null {
  if (r.type !== "estimate" || !Array.isArray(r.windows)) return null;
  const windows: WindowEstimate[] = [];
  // loop: NOT-WORTH — twelve windows, once per estimate
  for (const w of r.windows as Record<string, unknown>[]) {
    const peak = num(w.peak_bytes);
    const needs = num(w.needs_bytes);
    if (peak === null || needs === null) return null;
    windows.push({
      hannChunk: Number(w.hann_chunk),
      hannStride: Number(w.hann_stride),
      lowVram: w.low_vram === true,
      peakBytes: peak,
      needsBytes: needs,
      fits: typeof w.fits === "boolean" ? w.fits : null,
    });
  }
  return {
    width: Number(r.width),
    height: Number(r.height),
    frames: Number(r.frames),
    totalBytes: num(r.total_bytes),
    freeBytes: num(r.free_bytes),
    budgetBytes: num(r.budget_bytes),
    capGb: num(r.budget_cap_gb),
    provider: typeof r.provider === "string" ? r.provider : null,
    windows,
    at,
  };
}

/** Why there is no estimate, in words, for an engine `error` reply. */
export function estimateErrorText(r: EngineReply): string {
  const message = String(r.message ?? "");
  if (r.code === "bad-request" && message.startsWith("unknown cmd")) return "This engine doesn't give memory estimates (an older engine).";
  return `The engine couldn't estimate this clip: ${message}`;
}

export class Estimator {
  private cache = new Map<string, MemoryEstimate>();
  private proc: EngineHandle | null = null;
  // one estimate engine at a time: each ask waits for the one before
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private now: () => number;

  constructor(private readonly deps: EstimatorDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * The estimate for a clip under its graphics memory limit (null = Auto). `engineBusy`: the queue runs, so no
   * engine is started; the last reading (if any) comes back marked stale.
   */
  ask(input: string, engineBusy: boolean, limitGb: number | null = null, modelScale = 1): Promise<MemoryEstimateResult> {
    const key = cacheKey(input, limitGb, modelScale);
    const cached = this.cache.get(key);
    if (engineBusy) return Promise.resolve(cached ? { ok: true, estimate: cached, stale: true } : { ok: false, reason: "Shown when the queue isn't running (the engine is busy keying)." });
    if (cached && this.now() - cached.at < ESTIMATE_FRESH_MS) return Promise.resolve({ ok: true, estimate: cached, stale: false });
    const next = this.chain.then(() => this.read(input, limitGb, modelScale));
    // error: NOT-WORTH — read() resolves with its failure; the chain only orders the asks
    this.chain = next.catch(() => {});
    return next;
  }

  /** Stop a running estimate engine (the queue is starting, or the app quits). */
  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }

  private async read(input: string, limitGb: number | null, modelScale: number): Promise<MemoryEstimateResult> {
    const key = cacheKey(input, limitGb, modelScale);
    // a fresh reading may have come in while this ask waited its turn
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < ESTIMATE_FRESH_MS) return { ok: true, estimate: cached, stale: false };
    const id = `estimate-${++this.seq}`;
    let settle: (r: EngineReply | Error) => void = () => {};
    const answered = new Promise<EngineReply | Error>((res) => (settle = res));
    const proc = this.deps.makeEngine(
      (r) => {
        if (r.id === id) settle(r);
      },
      (code, signal) => settle(new Error(`the engine stopped (${signal ?? `exit code ${code}`})`)),
    );
    this.proc = proc;
    // loop: SERIAL-REQUIRED — the estimate's deadline (ESTIMATE_TIMEOUT_MS), once per estimate; then a kill
    const timer = setTimeout(() => {
      settle(new Error(`no answer within ${ESTIMATE_TIMEOUT_MS / 1000} s`));
      proc.kill();
    }, ESTIMATE_TIMEOUT_MS);
    try {
      await proc.start();
      proc.send(estimateRequest(id, input, limitGb, modelScale));
      // loop: SERIAL-REQUIRED — waits for the one reply [bounded: ESTIMATE_TIMEOUT_MS, or the engine's exit]
      const r = await answered;
      if (r instanceof Error) return { ok: false, reason: `No estimate: ${r.message}.` };
      if (r.type === "error") return { ok: false, reason: estimateErrorText(r) };
      const estimate = parseEstimate(r, this.now());
      if (!estimate) return { ok: false, reason: "No estimate: the engine's reply couldn't be read." };
      this.cache.delete(key);
      this.cache.set(key, estimate);
      // loop: NOT-WORTH — drops at most one reading per added one
      while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
      return { ok: true, estimate, stale: false };
    } catch (e) {
      // error: SHOWN — the picker says why there is no estimate
      return { ok: false, reason: `No estimate: ${(e as Error).message}.` };
    } finally {
      clearTimeout(timer);
      if (this.proc === proc) this.proc = null;
      proc.quit();
    }
  }
}
