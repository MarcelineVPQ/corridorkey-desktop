// The job queue: owns the jobs and the one engine process, turns engine
// replies into job state. Every number a job shows comes from an engine reply
// (rule 1); nothing here estimates progress on its own.
import { rmSync } from "node:fs";
import type { EngineReply } from "./engine";
import type { EngineState, Job, JobOptions, OutputName, Stage } from "../../src/shared/types";

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
  now?: () => number;
}

/** The engine's `options` object for a job (docs/ENGINE_PROTOCOL.md). */
export function engineOptions(o: JobOptions, kind: "video" | "frames"): Record<string, unknown> {
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
  if (kind === "frames") {
    out.frame_dir_fps = o.frameDirFps;
    out.frame_dir_linear = o.frameDirLinear;
  }
  return out;
}

const STAGES = new Set<Stage>(["load", "probe", "rvm", "foundations", "keying"]);

export class Queue {
  jobs: Job[] = [];
  running = false;
  engine: EngineState = { status: "stopped", pong: null, error: null };
  private proc: EngineHandle | null = null;
  private current: Job | null = null;
  private rateStart: { at: number; frames: number } | null = null;
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
    const job = this.jobs.find((j) => j.id === id);
    if (!job || job.status === "running") return;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.deps.changed();
  }

  retry(id: string): void {
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
      startedAt: null,
      finishedAt: null,
      outputs: [],
      stills: [],
      error: null,
      log: [],
    });
    this.deps.changed();
    if (this.running && !this.current) this.next();
  }

  setOptions(id: string, options: JobOptions): void {
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
      this.finish(job, "cancelled", null);
      this.proc?.kill();
      this.proc = null;
      this.engine = { status: "stopped", pong: null, error: null };
      this.cleanTemp(job.id);
    }
    this.deps.changed();
  }

  /** App quit: kill whatever runs, no state updates needed. */
  shutdown(): void {
    this.running = false;
    this.proc?.kill();
    if (this.current) this.cleanTemp(this.current.id);
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
          python: String(pong.python),
          torch: String(pong.torch),
          assets: (pong.assets as Record<string, boolean>) ?? {},
        },
      };
      this.deps.changed();
      return true;
    } catch (e) {
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
    const job = this.jobs.find((j) => j.status === "waiting" && !j.clip.probeError);
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
    this.proc!.send({
      cmd: "run",
      id: job.id,
      input: job.clip.path,
      output_dir: job.outputDir,
      temp_dir: this.deps.tempDirFor(job.id),
      options: engineOptions(job.options, job.clip.kind),
    });
  }

  private reply(r: EngineReply): void {
    const job = this.current;
    if (!job || r.id !== job.id) return;
    switch (r.type) {
      case "progress":
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
      case "log":
        job.log.push(String(r.text));
        if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
        break;
      case "result":
        job.outputs = Array.isArray(r.outputs) ? (r.outputs as string[]) : [];
        this.current = null;
        this.finish(job, "done", null);
        this.next();
        return;
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
      this.cleanTemp(job.id);
      this.next();
      return;
    }
    this.deps.changed();
  }

  private finish(job: Job, status: "done" | "failed" | "cancelled", error: Job["error"]): void {
    job.status = status;
    job.finishedAt = this.now();
    job.error = error;
    if (status !== "done") job.stage = null;
    this.deps.changed();
    this.deps.finished(job);
  }

  private cleanTemp(id: string): void {
    try {
      rmSync(this.deps.tempDirFor(id), { recursive: true, force: true });
    } catch {
      // error: NOT-WORTH — a temp folder we couldn't remove; the next start of that job clears it (safe_remove)
    }
  }
}

export function outputStem(name: OutputName, despill: number): string {
  return name === "checker" ? `checker_comp_despill${String(Math.round(despill * 100)).padStart(3, "0")}` : name;
}
