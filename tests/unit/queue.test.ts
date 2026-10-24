import { discardsSettled } from "../../electron/main/partial";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { clearJobTemps, engineOptions, Queue, type EngineHandle } from "../../electron/main/queue";
import type { EngineReply } from "../../electron/main/engine";
import { DEFAULT_OPTIONS, type Job } from "../../src/shared/types";

// the jobs' output folders: real ones (the queue stages each job's files there, partial.ts)
const OUT = mkdtempSync(join(tmpdir(), "ck-queue-out-"));
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

function job(id: string, extra: Partial<Job> = {}): Job {
  return {
    id,
    clip: { path: `/c/${id}.mp4`, name: id, kind: "video", width: 640, height: 360, fps: 24, frames: 24, thumb: null, companionFirstFrame: null, companionHintVideo: null, probeError: null },
    options: { ...DEFAULT_OPTIONS },
    outputDir: join(OUT, `out_${id}`),
    status: "waiting",
    stage: null,
    stageDetail: null,
    framesDone: 0,
    framesTotal: 24,
    framesPerSecond: null,
    memory: null,
    startedAt: null,
    finishedAt: null,
    outputs: [],
    stills: [],
    error: null,
    partial: null,
    log: [],
    ...extra,
  };
}

function harness(opts: { pongProtocol?: number; failStart?: boolean; slowStart?: boolean; tempRoot?: string } = {}) {
  const sent: Record<string, unknown>[] = [];
  let reply: (r: EngineReply) => void = () => {};
  let exit: (c: number | null, s: NodeJS.Signals | null, t: string[]) => void = () => {};
  let killed = 0;
  let quits = 0;
  let clock = 0;
  const engines: EngineHandle[] = [];
  const q = new Queue({
    makeEngine: (onReply, onExit) => {
      reply = onReply;
      exit = onExit;
      // slowStart: no pong yet; a kill ends the start as EngineProcess does ("exited before answering")
      let rejectStart: (e: Error) => void = () => {};
      const h: EngineHandle = {
        running: true,
        pid: 4242,
        start: () =>
          opts.slowStart
            ? new Promise((_r, j) => (rejectStart = j))
            : opts.failStart
              ? Promise.reject(new Error("no python"))
              : Promise.resolve({ type: "pong", protocol: opts.pongProtocol ?? 1, version: "0.1.0", engine: "pytorch", device: "cuda" }),
        send: (m) => sent.push(m),
        quit: () => quits++,
        kill: () => {
          killed++;
          rejectStart(new Error("engine exited before answering (SIGKILL)"));
        },
        stderrTail: () => ["trace line"],
      };
      engines.push(h);
      return h;
    },
    tempDirFor: (id) => join(opts.tempRoot ?? "/nonexistent-ck-test", id),
    changed: () => {},
    finished: () => {},
    now: () => clock,
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    q,
    sent,
    reply: (r: EngineReply) => reply(r),
    exit: (c: number | null, s: NodeJS.Signals | null) => exit(c, s, ["boom"]),
    killed: () => killed,
    quits: () => quits,
    engines,
    flush,
    tick: (ms: number) => (clock += ms),
  };
}

describe("Queue", () => {
  it("runs jobs in order and quits the engine when the queue is empty", async () => {
    const h = harness();
    h.q.add(job("a"));
    h.q.add(job("b"));
    await h.q.start();
    await h.flush();
    expect(h.sent.map((m) => m.id)).toEqual(["a"]);
    h.reply({ type: "result", id: "a", outputs: [join(OUT, "out_a", ".corridorkey-partial", "a_alpha.mp4")] });
    await h.flush();
    expect(h.q.jobs[0].status).toBe("done");
    expect(h.q.jobs[0].outputs).toEqual([join(OUT, "out_a", "a_alpha.mp4")]);
    expect(h.sent.map((m) => m.id)).toEqual(["a", "b"]);
    expect(h.engines).toHaveLength(1); // the model stays loaded between jobs
    h.reply({ type: "result", id: "b", outputs: [] });
    await h.flush();
    expect(h.quits()).toBe(1);
    expect(h.q.running).toBe(false);
  });

  it("takes progress only from engine replies and measures the rate", async () => {
    const h = harness();
    h.q.add(job("a"));
    await h.q.start();
    await h.flush();
    h.reply({ type: "memory", id: "a", hann_chunk: 24, hann_stride: 12, low_vram: false, auto: true, budget_gb: 13.2, estimate_gb: 7.5 });
    h.reply({ type: "frames", id: "a", done: 2, total: 24 });
    expect(h.q.jobs[0].framesPerSecond).toBeNull();
    h.tick(4000);
    h.reply({ type: "frames", id: "a", done: 10, total: 24 });
    expect(h.q.jobs[0].framesPerSecond).toBeCloseTo(2);
    expect(h.q.jobs[0].memory).toMatchObject({ hannChunk: 24, budgetGb: 13.2, estimateGb: 7.5 });
    h.reply({ type: "frames", id: "other", done: 99, total: 99 });
    expect(h.q.jobs[0].framesDone).toBe(10);
  });

  it("stop kills the engine, marks the job cancelled and keeps the waiting ones", async () => {
    const h = harness();
    h.q.add(job("a"));
    h.q.add(job("b"));
    await h.q.start();
    await h.flush();
    h.q.stop();
    expect(h.killed()).toBe(1);
    expect(h.q.jobs.map((j) => j.status)).toEqual(["cancelled", "waiting"]);
    expect(h.q.running).toBe(false);
  });

  it("an engine crash fails the job with the stderr tail and moves on", async () => {
    const h = harness();
    h.q.add(job("a"));
    h.q.add(job("b"));
    await h.q.start();
    await h.flush();
    h.exit(null, "SIGSEGV");
    await h.flush();
    expect(h.q.jobs[0].status).toBe("failed");
    expect(h.q.jobs[0].error?.stderrTail).toEqual(["boom"]);
    expect(h.engines).toHaveLength(2); // a fresh engine for the next job
  });

  it("an engine that won't start fails the job and stops the queue", async () => {
    const h = harness({ failStart: true });
    h.q.add(job("a"));
    await h.q.start();
    await h.flush();
    expect(h.q.jobs[0].status).toBe("failed");
    expect(h.q.engine.status).toBe("failed");
    expect(h.q.running).toBe(false);
  });

  it("stop while the engine is still starting: the job is cancelled, the engine stopped (not failed)", async () => {
    const h = harness({ slowStart: true });
    h.q.add(job("a"));
    await h.q.start();
    await h.flush();
    h.q.stop();
    await h.flush();
    expect(h.q.jobs[0].status).toBe("cancelled");
    expect(h.q.engine).toEqual({ status: "stopped", pong: null, error: null });
    expect(h.q.running).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it("removes a job's temp folder when the job ends, however it ends", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-queue-"));
    try {
      const h = harness({ tempRoot: root });
      // loop: NOT-WORTH — three test jobs
      for (const id of ["a", "b", "c"]) {
        mkdirSync(join(root, id));
        writeFileSync(join(root, id, "left.f16"), "x");
        h.q.add(job(id));
      }
      await h.q.start();
      await h.flush();
      h.reply({ type: "result", id: "a", outputs: [] });
      await h.flush();
      h.reply({ type: "error", id: "b", code: "input", message: "bad" });
      await h.flush();
      h.exit(null, "SIGSEGV");
      await h.flush();
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears job temp folders left by an earlier run (a crash, a killed engine)", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-jobs-"));
    try {
      mkdirSync(join(root, "old-job"));
      writeFileSync(join(root, "old-job", "baton.f16"), "x");
      clearJobTemps(root);
      expect(existsSync(root)).toBe(true);
      expect(readdirSync(root)).toEqual([]);
      clearJobTemps(join(root, "missing")); // nothing there: no error
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("only waiting jobs can be edited, failed ones can be retried", async () => {
    const h = harness();
    h.q.add(job("a", { status: "failed", error: { code: "oom", message: "x", stderrTail: [] } }));
    h.q.setOptions("a", { ...DEFAULT_OPTIONS, despillStrength: 0 });
    expect(h.q.jobs[0].options.despillStrength).toBe(0.5);
    h.q.retry("a");
    expect(h.q.jobs[0].status).toBe("waiting");
    expect(h.q.jobs[0].error).toBeNull();
  });
});

// Backlog row 19: a failed or cancelled job removes the files it had started, and only those.
describe("a job's started files (staging, partial.ts)", () => {
  // An output folder that holds a previous successful run's results (a video, an EXR folder) and a file of the user's.
  function earlierRun(id: string): string {
    const dir = join(OUT, `out_${id}`);
    mkdirSync(join(dir, `${id}_alpha_exr`), { recursive: true });
    writeFileSync(join(dir, `${id}_alpha.mp4`), "earlier result");
    writeFileSync(join(dir, `${id}_alpha_exr`, "000000.exr"), "earlier frame");
    writeFileSync(join(dir, "notes.txt"), "the user's");
    return dir;
  }
  // What the engine writes before it fails: into the output_dir it was given, under the names it always uses.
  function engineWrites(h: ReturnType<typeof harness>, id: string): string {
    const out = String(h.sent.find((m) => m.id === id)!.output_dir);
    mkdirSync(join(out, `${id}_alpha_exr`), { recursive: true });
    writeFileSync(join(out, `${id}_alpha.mp4`), "half-written");
    writeFileSync(join(out, `${id}_alpha_exr`, "000000.exr"), "new frame");
    writeFileSync(join(out, `${id}_settings.txt`), `Output Directory: ${out}\n`);
    return out;
  }
  // after discardsSettled(): a discarded job's files are renamed aside, then deleted in the background
  const earlierIntact = async (dir: string, id: string) => {
    await discardsSettled();
    expect(readFileSync(join(dir, `${id}_alpha.mp4`), "utf8")).toBe("earlier result");
    expect(readFileSync(join(dir, `${id}_alpha_exr`, "000000.exr"), "utf8")).toBe("earlier frame");
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("the user's");
    expect(readdirSync(dir).sort()).toEqual([`${id}_alpha.mp4`, `${id}_alpha_exr`, "notes.txt"]);
  };

  it("a failed job: its files go, the earlier run's results and the user's files stay", async () => {
    const dir = earlierRun("f1");
    const h = harness();
    h.q.add(job("f1"));
    await h.q.start();
    await h.flush();
    engineWrites(h, "f1");
    h.reply({ type: "error", id: "f1", code: "engine", message: "decode failed" });
    await h.flush();
    expect(h.q.jobs[0].status).toBe("failed");
    await earlierIntact(dir, "f1");
    expect(h.q.jobs[0].partial).toBe("Removed the 3 files it had started; earlier results in the folder are untouched.");
  });

  it("a cancelled job (the engine killed): the same", async () => {
    const dir = earlierRun("c1");
    const h = harness();
    h.q.add(job("c1"));
    await h.q.start();
    await h.flush();
    engineWrites(h, "c1");
    h.q.stop();
    expect(h.killed()).toBe(1);
    expect(h.q.jobs[0].status).toBe("cancelled");
    await discardsSettled();
    await earlierIntact(dir, "c1");
    expect(h.q.jobs[0].partial).toMatch(/^Removed the 3 files/);
  });

  it("an engine crash: the same; an output folder the job made is removed when it is left empty", async () => {
    const h = harness();
    h.q.add(job("x1"));
    await h.q.start();
    await h.flush();
    engineWrites(h, "x1");
    h.exit(null, "SIGSEGV");
    await h.flush();
    expect(h.q.jobs[0].status).toBe("failed");
    await discardsSettled();
    expect(existsSync(join(OUT, "out_x1"))).toBe(false);
  });

  it("a job stopped before it wrote anything says so", async () => {
    const h = harness();
    h.q.add(job("n1"));
    await h.q.start();
    await h.flush();
    h.q.stop();
    expect(h.q.jobs[0].partial).toBe("It hadn't written any files.");
  });

  it("success: the new results replace the earlier ones, the user's file stays, the settings file names the real folder", async () => {
    const dir = earlierRun("s1");
    const h = harness();
    h.q.add(job("s1"));
    await h.q.start();
    await h.flush();
    const out = engineWrites(h, "s1");
    h.reply({ type: "result", id: "s1", outputs: [join(out, "s1_alpha.mp4"), join(out, "s1_alpha_exr")] });
    await h.flush();
    const j = h.q.jobs[0];
    expect(j.status).toBe("done");
    expect(j.partial).toBeNull();
    expect(j.outputs).toEqual([join(dir, "s1_alpha.mp4"), join(dir, "s1_alpha_exr")]);
    expect(readFileSync(join(dir, "s1_alpha.mp4"), "utf8")).toBe("half-written");
    expect(readdirSync(join(dir, "s1_alpha_exr"))).toEqual(["000000.exr"]);
    expect(readFileSync(join(dir, "s1_alpha_exr", "000000.exr"), "utf8")).toBe("new frame");
    expect(readFileSync(join(dir, "s1_settings.txt"), "utf8")).toBe(`Output Directory: ${dir}\n`);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("the user's");
    // the replaced EXR folder is removed in the background, then nothing of the staging is left
    // loop: SERIAL-REQUIRED — waits for the background removal [bounded: 50 × 20 ms]
    for (let i = 0; i < 50 && existsSync(join(dir, ".corridorkey-partial")); i++) await new Promise((r) => setTimeout(r, 20));
    expect(readdirSync(dir).sort()).toEqual(["notes.txt", "s1_alpha.mp4", "s1_alpha_exr", "s1_settings.txt"]);
  });
});

describe("engineOptions", () => {
  it("sends a manual window only in manual mode and hints only for their mode", () => {
    const auto = engineOptions({ ...DEFAULT_OPTIONS, hintMode: "none", hintFirstFrame: "/h.png" }, "video");
    expect(auto).not.toHaveProperty("hann_chunk");
    expect(auto).not.toHaveProperty("hint_first_frame");
    const manual = engineOptions({ ...DEFAULT_OPTIONS, hintMode: "first-frame", hintFirstFrame: "/h.png", memory: { auto: false, hannChunk: 8, hannStride: 4, lowVram: true } }, "frames");
    expect(manual).toMatchObject({ hann_chunk: 8, hann_stride: 4, low_vram: true, hint_first_frame: "/h.png", frame_dir_fps: 24 });
  });
});
