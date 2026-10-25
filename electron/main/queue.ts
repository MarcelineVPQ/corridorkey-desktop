// The job queue: owns the jobs and the one engine process, turns engine
// replies into job state. Every number a job shows comes from an engine reply
// (rule 1); nothing here estimates progress on its own.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EngineReply } from "./engine";
import type { EngineState, Job, JobOptions, JobTech, OutputName, Stage } from "../../src/shared/types";
import { missingInput } from "../../src/shared/tasks";
import { discard, finalPath, PARTIAL_DIR as PARTIAL_NAME, prepare, promote } from "./partial";

const LOG_LINES = 300;
// Frames per second is shown once this many frames and seconds are measured.
const RATE_MIN_FRAMES = 3;
const RATE_MIN_SECONDS = 2;

export interface EngineHandle {
  start(): Promise<EngineReply>;
  send(msg: Record<string, unknown>): void;
  quit(): void;
  kill(): void;
  stderrTail(): string[];
  readonly running: boolean;
  readonly pid?: number;
}

export interface QueueDeps {
  makeEngine(onReply: (r: EngineReply) => void, onExit: (code: number | null, signal: NodeJS.Signals | null, stderrTail: string[]) => void): EngineHandle;
  tempDirFor(jobId: string): string;
  changed(): void;
  finished(job: Job): void;
  // ask the running engine for TensorRT (asked per job: the Rust engine, the setting on, its parts installed)
  tensorrt?: () => boolean;
  // why a job doesn't ask for TensorRT (install.ts tensorrtWhyNot), shown on its page
  tensorrtWhyNot?: () => string | null;
  now?: () => number;
}

/**
 * The engine's `options` object for a job (docs/ENGINE_PROTOCOL.md). `tensorrt`: the Rust engine runs it on
 * TensorRT (index.ts sends it only with the setting on and the TensorRT parts installed; never to the PyTorch engine).
 * `rust`: the engine is the Rust engine, which takes `video_codec`; the PyTorch reference engine writes the
 * original's H.264 CRF 12 whatever the job says (the panel says so), so it never gets the key.
 */
export function engineOptions(o: JobOptions, kind: "video" | "frames", tensorrt = false, rust = false): Record<string, unknown> {
  const out: Record<string, unknown> = {
    hint_quality: o.hintQuality,
    carry_hint: o.carryHint,
    outputs: o.outputs,
    output_format: o.outputFormat,
    exr_dtype: o.exrDtype,
    despill_strength: o.despillStrength,
    cutout_linear: o.cutoutLinear,
  };
  if (o.hintMode === "first-frame" && o.hintFirstFrame) out.hint_first_frame = o.hintFirstFrame;
  if (o.hintMode === "video" && o.hintVideo) out.hint_video = o.hintVideo;
  if (!o.memory.auto) {
    out.hann_chunk = o.memory.hannChunk;
    out.hann_stride = o.memory.hannStride;
    out.low_vram = o.memory.lowVram;
  }
  // the graphics memory limit (backlog row 43); none = Auto
  if (o.vramLimitGb !== null) out.vram_budget_gb = o.vramLimitGb;
  if (kind === "frames") {
    out.frame_dir_fps = o.frameDirFps;
    out.frame_dir_linear = o.frameDirLinear;
  }
  // internal resolution (backlog row 42): sent only when not full, so a job at full sends what it always did
  if (o.modelScale !== 1) out.model_scale = o.modelScale;
  // the linear adjust (row 45): video clips only (the original's frame-folder probe ignores it), and only when set
  if (kind === "video" && (o.linearBrightness !== 1 || o.linearContrast !== 1)) {
    out.linear_brightness = o.linearBrightness;
    out.linear_contrast = o.linearContrast;
    out.linear_contrast_pivot = o.linearContrastPivot;
  }
  // a job never builds TensorRT engines: a range not built yet runs on CUDA while the app builds it in the background (trtPrebuild.ts)
  if (tensorrt) {
    out.tensorrt = true;
    out.tensorrt_build = false;
  }
  if (rust && o.outputFormat === "video") out.video_codec = o.videoCodec;
  return out;
}

/** The job log's line for a `provider` reply about TensorRT (null for a plain job: nothing to add). */
export function providerText(r: EngineReply): string | null {
  if (typeof r.fallback_reason === "string") return `TensorRT not used: ${r.fallback_reason}. Runs on ${String(r.provider ?? "cuda").toUpperCase()}.`;
  if (r.fallbacks && typeof r.fallbacks === "object") {
    // loop: NOT-WORTH — at most five networks, once per TensorRT job
    const fell = Object.entries(r.fallbacks as Record<string, unknown>).map(([k, why]) => `${k} (${String(why)})`);
    // loop: NOT-WORTH — as above
    const built = Object.values((r.build_s ?? {}) as Record<string, unknown>).reduce<number>((n, s) => n + (typeof s === "number" ? s : 0), 0);
    const head = r.provider === "cuda" ? "TensorRT couldn't take any network: runs on CUDA" : "Runs on TensorRT";
    return `${head}${built > 0 ? ` (engines built in ${Math.round(built)} s, kept for this resolution)` : ""}${fell.length && r.provider !== "cuda" ? `; on CUDA: ${fell.join(", ")}` : fell.length ? `: ${fell.join(", ")}` : ""}.`;
  }
  if (r.tensorrt_requested === true && typeof r.range === "string")
    return r.cache === "build" ? `TensorRT: building the engines for this resolution (${r.range}), once.` : `TensorRT: engines for this resolution (${r.range}) reused.`;
  return null;
}

const NO_TECH: JobTech = { provider: null, precision: null, tensorrtRequested: false, fallbackReason: null, fallbacks: {}, range: null, cache: null, notAsked: null };

/**
 * What ran a job, from the engine's `provider` replies, each field as the engine sent it. A TensorRT job gets two:
 * the first at its start (provider, precision, range, cache), the second once its networks are loaded (the real
 * provider and the networks that fell back to CUDA); the second keeps what only the first said.
 */
export function techFrom(r: EngineReply, prev: JobTech | null | undefined): JobTech {
  const p = prev ?? NO_TECH;
  const str = (v: unknown, was: string | null) => (typeof v === "string" ? v : was);
  let fallbacks = p.fallbacks;
  if (r.fallbacks && typeof r.fallbacks === "object") {
    fallbacks = {};
    // loop: NOT-WORTH — at most five networks, once per job
    for (const [k, why] of Object.entries(r.fallbacks as Record<string, unknown>)) fallbacks[k] = String(why);
  }
  const requested = typeof r.tensorrt_requested === "boolean" ? r.tensorrt_requested : p.tensorrtRequested;
  return {
    provider: str(r.provider, p.provider),
    precision: str(r.precision, p.precision),
    tensorrtRequested: requested,
    fallbackReason: str(r.fallback_reason, p.fallbackReason),
    fallbacks,
    range: str(r.range, p.range),
    cache: str(r.cache, p.cache),
    notAsked: requested ? null : p.notAsked,
  };
}

const STAGES = new Set<Stage>(["load", "optimize", "probe", "rvm", "foundations", "keying"]);

export class Queue {
  jobs: Job[] = [];
  running = false;
  engine: EngineState = { status: "stopped", pong: null, error: null };
  private proc: EngineHandle | null = null;
  private current: Job | null = null;
  private rateStart: { at: number; frames: number } | null = null;
  // the running job's staging folder (partial.ts): set once the engine was given it
  private staged = new Map<string, { madeOutputDir: boolean }>();
  private now: () => number;

  constructor(private readonly deps: QueueDeps) {
    this.now = deps.now ?? Date.now;
  }

  get enginePid(): number | undefined {
    return this.proc?.running ? this.proc.pid : undefined;
  }

  add(job: Job): void {
    this.jobs.push(job);
    this.deps.changed();
    if (this.running && !this.current) this.next();
  }

  remove(id: string): void {
    // loop: NOT-WORTH — the queue's jobs, once per user action
    const job = this.jobs.find((j) => j.id === id);
    if (!job || job.status === "running") return;
    // loop: NOT-WORTH — the queue's jobs, once per user action
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.deps.changed();
  }

  retry(id: string): void {
    // loop: NOT-WORTH — the queue's jobs, once per user action
    const job = this.jobs.find((j) => j.id === id);
    if (!job || (job.status !== "failed" && job.status !== "cancelled")) return;
    Object.assign(job, {
      status: "waiting",
      stage: null,
      stageDetail: null,
      framesDone: 0,
      framesTotal: null,
      framesPerSecond: null,
      memory: null,
      tech: null,
      startedAt: null,
      finishedAt: null,
      outputs: [],
      stills: [],
      error: null,
      partial: null,
      log: [],
    });
    this.deps.changed();
    if (this.running && !this.current) this.next();
  }

  setOptions(id: string, options: JobOptions): void {
    // loop: NOT-WORTH — the queue's jobs, once per user action
    const job = this.jobs.find((j) => j.id === id);
    if (!job || job.status !== "waiting") return;
    job.options = options;
    this.deps.changed();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.deps.changed();
    this.next();
  }

  /** Stop the queue: the running job is cancelled (engine killed), waiting jobs stay. */
  stop(): void {
    this.running = false;
    if (this.current) {
      const job = this.current;
      this.current = null;
      // killed first, so nothing writes into the temp folder finish() removes
      this.proc?.kill();
      this.proc = null;
      this.engine = { status: "stopped", pong: null, error: null };
      this.finish(job, "cancelled", null);
    }
    this.deps.changed();
  }

  /** App quit: kill whatever runs, no state updates needed. */
  shutdown(): void {
    this.running = false;
    this.proc?.kill();
    if (this.current) {
      this.cleanTemp(this.current.id);
      const st = this.staged.get(this.current.id);
      if (st) discard(this.current.outputDir, st.madeOutputDir);
    }
  }

  private async ensureEngine(): Promise<boolean> {
    if (this.proc?.running && this.engine.status === "ready") return true;
    this.engine = { status: "starting", pong: null, error: null };
    this.deps.changed();
    const proc = this.deps.makeEngine(
      (r) => this.reply(r),
      (code, signal, tail) => this.exited(proc, code, signal, tail),
    );
    this.proc = proc;
    try {
      const pong = await proc.start();
      if (this.proc !== proc) return false;
      this.engine = {
        status: "ready",
        error: null,
        pong: {
          version: String(pong.version),
          protocol: Number(pong.protocol),
          engine: String(pong.engine),
          device: String(pong.device),
          gpu: (pong.gpu as string | null) ?? null,
          vramTotalMb: (pong.vram_total_mb as number | null) ?? null,
          python: typeof pong.python === "string" ? pong.python : null,
          torch: typeof pong.torch === "string" ? pong.torch : null,
          ort: typeof pong.ort === "string" ? pong.ort : null,
          provider: typeof pong.provider === "string" ? pong.provider : null,
          precision: typeof pong.precision === "string" ? pong.precision : null,
          assets: (pong.assets as Record<string, boolean>) ?? {},
        },
      };
      this.deps.changed();
      return true;
    } catch (e) {
      // stopped by the user while it started (stop() killed it and already reset the state): not a failure
      if (this.proc !== proc) return false;
      // error: SHOWN — the engine card and the waiting jobs say why it didn't start
      this.engine = { status: "failed", pong: null, error: e instanceof Error ? e.message : String(e) };
      this.running = false;
      this.proc = null;
      this.deps.changed();
      return false;
    }
  }

  private async next(): Promise<void> {
    if (!this.running || this.current) return;
    // A clip whose hint mode needs a file it doesn't have stays waiting (its task says so); never run it silently without the hint.
    // loop: NOT-WORTH — the queue's jobs, once per job start
    const job = this.jobs.find((j) => j.status === "waiting" && !j.clip.probeError && !missingInput(j));
    if (!job) {
      this.running = false;
      this.proc?.quit(); // frees the graphics memory the model holds
      this.proc = null;
      this.engine = { status: "stopped", pong: this.engine.pong, error: null };
      this.deps.changed();
      return;
    }
    this.current = job;
    Object.assign(job, { status: "running", stage: "start", startedAt: this.now(), framesTotal: job.clip.frames });
    this.rateStart = null;
    this.deps.changed();
    if (!(await this.ensureEngine())) {
      if (this.current === job) {
        this.current = null;
        this.finish(job, "failed", { code: "engine", message: this.engine.error ?? "engine did not start", stderrTail: [] });
      }
      return;
    }
    if (this.current !== job) return;
    let staging: string;
    try {
      const st = prepare(job.outputDir);
      staging = st.staging;
      this.staged.set(job.id, { madeOutputDir: st.madeOutputDir });
    } catch (e) {
      // error: SHOWN — the job fails naming the folder
      this.current = null;
      this.finish(job, "failed", { code: "engine", message: `Couldn't create the output folder ${job.outputDir}: ${(e as Error).message}`, stderrTail: [] });
      this.next();
      return;
    }
    const trt = this.deps.tensorrt?.() ?? false;
    // what ran it comes from the engine's provider reply; the app's own part is why it didn't ask for TensorRT
    job.tech = { ...NO_TECH, notAsked: trt ? null : (this.deps.tensorrtWhyNot?.() ?? null) };
    this.proc!.send({
      cmd: "run",
      id: job.id,
      input: job.clip.path,
      output_dir: staging,
      temp_dir: this.deps.tempDirFor(job.id),
      options: engineOptions(job.options, job.clip.kind, trt, this.engine.pong?.engine === "onnxruntime"),
    });
  }

  private reply(r: EngineReply): void {
    const job = this.current;
    if (!job || r.id !== job.id) return;
    switch (r.type) {
      case "progress":
        // low-memory mode loads stage 2 after the last stage-1 window (pipeline/keying.rs stage2_pass): that load is
        // part of keying, whose frames go on, so the page stays on Keying with its window count
        if (r.stage === "load" && job.stage === "keying") break;
        if (STAGES.has(r.stage as Stage)) job.stage = r.stage as Stage;
        job.stageDetail = typeof r.detail === "string" ? r.detail : null;
        break;
      case "clip":
        job.framesTotal = Number(r.frames);
        break;
      case "memory":
        job.memory = {
          hannChunk: Number(r.hann_chunk),
          hannStride: Number(r.hann_stride),
          lowVram: Boolean(r.low_vram),
          auto: Boolean(r.auto),
          budgetGb: typeof r.budget_gb === "number" ? r.budget_gb : null,
          estimateGb: typeof r.estimate_gb === "number" ? r.estimate_gb : null,
          freeGb: typeof r.free_gb === "number" ? r.free_gb : null,
          limitGb: typeof r.budget_cap_gb === "number" ? r.budget_cap_gb : null,
        };
        break;
      case "frames": {
        job.framesDone = Number(r.done);
        job.framesTotal = Number(r.total);
        const at = this.now();
        if (!this.rateStart) this.rateStart = { at, frames: job.framesDone };
        const frames = job.framesDone - this.rateStart.frames;
        const seconds = (at - this.rateStart.at) / 1000;
        if (frames >= RATE_MIN_FRAMES && seconds >= RATE_MIN_SECONDS) job.framesPerSecond = frames / seconds;
        break;
      }
      case "provider": {
        job.tech = techFrom(r, job.tech);
        const text = providerText(r);
        if (text) {
          job.log.push(text);
          if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
        }
        break;
      }
      case "log":
        job.log.push(String(r.text));
        if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
        break;
      case "result": {
        // loop: NOT-WORTH — ≤ four output paths, once per job
        job.outputs = Array.isArray(r.outputs) ? (r.outputs as string[]).map((p) => finalPath(job.outputDir, String(p))) : [];
        this.current = null;
        const moved = this.staged.has(job.id) ? promote(job.outputDir) : { moved: 0, error: null };
        this.staged.delete(job.id);
        if (moved.error)
          this.finish(job, "failed", {
            code: "engine",
            message: `The results are complete but couldn't be moved into ${job.outputDir} (${moved.error}); what wasn't moved is in its ${PARTIAL_NAME} folder.`,
            stderrTail: [],
          });
        else this.finish(job, "done", null);
        this.next();
        return;
      }
      case "error":
        this.current = null;
        this.finish(job, String(r.code) === "cancelled" ? "cancelled" : "failed", { code: String(r.code), message: String(r.message), stderrTail: this.proc?.stderrTail() ?? [] });
        this.next();
        return;
    }
    this.deps.changed();
  }

  private exited(proc: EngineHandle, code: number | null, signal: NodeJS.Signals | null, tail: string[]): void {
    if (this.proc !== proc) return; // a killed engine we already replaced
    this.proc = null;
    this.engine = { status: "stopped", pong: this.engine.pong, error: null };
    const job = this.current;
    if (job) {
      this.current = null;
      this.finish(job, "failed", { code: "engine", message: `The engine stopped unexpectedly (${signal ?? `exit code ${code}`}).`, stderrTail: tail });
      this.next();
      return;
    }
    this.deps.changed();
  }

  // Every ending removes the job's temp folder: the engine deletes its files but not the folder (an empty
  // folder per finished job was left in the cache), and a killed engine leaves its files too.
  // A failed / cancelled / crashed job's started files go with its staging folder; the row says so (backlog row 19).
  private finish(job: Job, status: "done" | "failed" | "cancelled", error: Job["error"]): void {
    this.cleanTemp(job.id);
    const st = this.staged.get(job.id);
    this.staged.delete(job.id);
    job.partial = status !== "done" && st ? discard(job.outputDir, st.madeOutputDir) : null;
    job.status = status;
    job.finishedAt = this.now();
    job.error = error;
    if (status !== "done") job.stage = null;
    this.deps.changed();
    this.deps.finished(job);
  }

  private cleanTemp(id: string): void {
    try {
      // loop: NOT-WORTH — removes a cancelled / crashed job's temp folder once (the killed engine's float16 temp files, up to a few GB: a few unlinks on a local disk)
      rmSync(this.deps.tempDirFor(id), { recursive: true, force: true });
    } catch {
      // error: NOT-WORTH — a temp folder we couldn't remove; the next start of that job clears it (safe_remove)
    }
  }
}

/** Remove every job folder under `root` (the app's jobs cache): called at start, when no engine runs, for what a
 * crash or a killed engine left (a low-VRAM job's temp files are GBs). */
export function clearJobTemps(root: string): void {
  let names: string[] = [];
  try {
    // loop: NOT-WORTH — the jobs folder's entries, once per app start
    names = readdirSync(root);
  } catch {
    // error: NOT-WORTH — no jobs folder yet: nothing to clear
    return;
  }
  // loop: NOT-WORTH — leftover job folders (usually none), once per app start
  for (const n of names) rmSync(join(root, n), { recursive: true, force: true });
}

export function outputStem(name: OutputName, despill: number): string {
  return name === "checker" ? `checker_comp_despill${String(Math.round(despill * 100)).padStart(3, "0")}` : name;
}
