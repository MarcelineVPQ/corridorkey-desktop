import { discardsSettled } from "../../electron/main/partial";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { clearJobTemps, engineOptions, providerText, Queue, type EngineHandle } from "../../electron/main/queue";
import type { EngineReply } from "../../electron/main/engine";
import { DEFAULT_OPTIONS, type Job } from "../../src/shared/types";
import { job as fixtureJob } from "./fixtures";

// the jobs' output folders: real ones (the queue stages each job's files there, partial.ts)
const OUT = mkdtempSync(join(tmpdir(), "ck-queue-out-"));
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

// a waiting job (fixtures.ts) whose results go into a real folder under OUT
const job = (id: string, extra: Partial<Job> = {}): Job => fixtureJob(id, { outputDir: join(OUT, `out_${id}`), ...extra });

function harness(opts: { pongProtocol?: number; failStart?: boolean; slowStart?: boolean; tempRoot?: string; tensorrt?: () => boolean; tensorrtWhyNot?: () => string | null } = {}) {
  const sent: Record<string, unknown>[] = [];
  let reply: (r: EngineReply) => void = () => {};
  let exit: (c: number | null, s: NodeJS.Signals | null, t: string[]) => void = () => {};
  let killed = 0;
  let quits = 0;
  let changes = 0;
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
              ? Promise.reject(new Error("no engine"))
              : Promise.resolve({ type: "pong", protocol: opts.pongProtocol ?? 1, version: "0.1.0", engine: "onnxruntime", device: "cuda" }),
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
    tensorrt: opts.tensorrt,
    tensorrtWhyNot: opts.tensorrtWhyNot,
    changed: () => changes++,
    finished: () => {},
    now: () => clock,
  });
  // the queue's folder work is async (output folders can be on a share): flush waits for it too
  const flush = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await q.settled();
  };
  return {
    q,
    sent,
    reply: (r: EngineReply) => reply(r),
    exit: (c: number | null, s: NodeJS.Signals | null) => exit(c, s, ["boom"]),
    killed: () => killed,
    quits: () => quits,
    changes: () => changes,
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
    expect(h.q.jobs[0].memory).toMatchObject({ hannChunk: 24, budgetGb: 13.2, estimateGb: 7.5, freeGb: null, limitGb: null });
    // the Rust engine's reply under a limit: the free memory it saw and the limit, apart
    h.reply({ type: "memory", id: "a", hann_chunk: 8, hann_stride: 4, low_vram: true, auto: true, budget_gb: 6, estimate_gb: 4.2, free_gb: 13.2, budget_cap_gb: 6 });
    expect(h.q.jobs[0].memory).toMatchObject({ budgetGb: 6, freeGb: 13.2, limitGb: 6 });
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
    await h.flush();
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
    await h.flush();
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

// bug hunt 2026-10-26 P6: the background TensorRT build went on the moment the queue ended, while the queue's engine was
// still quitting with its model in graphics memory (measured in an isolated copy: the build started 0.2 s after the queue's
// end); the engine's trt_build picks its window from the memory it reads free
describe("the queue's engine after the queue", () => {
  it("counts as ending until it has exited, after a quit and after a Stop, and says when it is gone", async () => {
    const h = harness();
    h.q.add(job("a"));
    await h.q.start();
    await h.flush();
    h.reply({ type: "result", id: "a", outputs: [] });
    await h.flush();
    expect(h.q.running).toBe(false);
    expect(h.quits()).toBe(1);
    expect(h.q.engineEnding).toBe(true);
    const before = h.changes();
    h.exit(0, null);
    expect(h.q.engineEnding).toBe(false);
    expect(h.changes()).toBeGreaterThan(before);

    const s = harness();
    s.q.add(job("b"));
    await s.q.start();
    await s.flush();
    s.q.stop();
    expect(s.killed()).toBe(1);
    expect(s.q.engineEnding).toBe(true);
    s.exit(null, "SIGKILL");
    expect(s.q.engineEnding).toBe(false);
  });
});

// bug hunt 2026-10-26 Q1 (measured in an isolated copy: the window closed during an EXR job left 1.7 GB of its frames in
// a hidden .corridorkey-discarded-* folder in the output folder, and its log said "failed: The engine stopped
// unexpectedly (SIGKILL)")
describe("the app quits while a job runs", () => {
  it("deletes the job's started files before its promise resolves (the quit waits for it), and the job ends as cancelled", async () => {
    const h = harness();
    const j = job("q");
    h.q.add(j);
    await h.q.start();
    await h.flush();
    const staging = String(h.sent[0].output_dir);
    mkdirSync(join(staging, "q_alpha_exr"), { recursive: true });
    // loop: NOT-WORTH — a few frames in a test
    for (let i = 0; i < 5; i++) writeFileSync(join(staging, "q_alpha_exr", `q_alpha.${1001 + i}.exr`), "frame");
    await h.q.shutdown();
    // nothing of the job is left (the folder it made goes too, empty)
    expect(existsSync(j.outputDir) ? readdirSync(j.outputDir) : []).toEqual([]);
    expect(j.status).toBe("cancelled");
    // the killed engine's exit is the quit, not a crash
    h.exit(null, "SIGKILL");
    expect(j.status).toBe("cancelled");
    expect(j.error).toBeNull();
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

  it("sends the graphics memory limit as vram_budget_gb, and none for Auto (backlog row 43)", () => {
    expect(engineOptions(DEFAULT_OPTIONS, "video")).not.toHaveProperty("vram_budget_gb");
    expect(engineOptions({ ...DEFAULT_OPTIONS, vramLimitGb: 10 }, "video")).toMatchObject({ vram_budget_gb: 10 });
    // a manual window keeps its limit too (the engine caps its CUDA memory at it)
    expect(engineOptions({ ...DEFAULT_OPTIONS, vramLimitGb: 6, memory: { auto: false, hannChunk: 8, hannStride: 4, lowVram: true } }, "video")).toMatchObject({ vram_budget_gb: 6, hann_chunk: 8 });
  });

  it("asks for TensorRT only when told to (never false-but-present)", () => {
    expect(engineOptions(DEFAULT_OPTIONS, "video")).not.toHaveProperty("tensorrt");
    expect(engineOptions(DEFAULT_OPTIONS, "video", false)).not.toHaveProperty("tensorrt");
    expect(engineOptions(DEFAULT_OPTIONS, "video", true)).toMatchObject({ tensorrt: true });
  });

  it("sends the video codec only for video outputs", () => {
    expect(engineOptions(DEFAULT_OPTIONS, "video")).toMatchObject({ video_codec: "h264-lossless" });
    expect(engineOptions({ ...DEFAULT_OPTIONS, videoCodec: "dnxhr444" }, "video")).toMatchObject({ video_codec: "dnxhr444" });
    expect(engineOptions({ ...DEFAULT_OPTIONS, outputFormat: "exr" }, "video")).not.toHaveProperty("video_codec");
  });

  it("sends 16-bit input reading only when asked (backlog row 27)", () => {
    // the default is CorridorKey 2.0's own 8-bit read: no key at all
    expect(engineOptions(DEFAULT_OPTIONS, "video")).not.toHaveProperty("input_bit_depth");
    expect(engineOptions({ ...DEFAULT_OPTIONS, deepInput: true }, "frames")).toMatchObject({ input_bit_depth: "16" });
  });

  it("sends the internal resolution when not full, and the linear adjust for video clips when set (backlog rows 42, 45)", () => {
    const d = engineOptions(DEFAULT_OPTIONS, "video");
    expect(d).not.toHaveProperty("model_scale");
    expect(d).not.toHaveProperty("linear_brightness");
    expect(engineOptions({ ...DEFAULT_OPTIONS, modelScale: 0.5 }, "frames")).toMatchObject({ model_scale: 0.5 });
    const lin = { ...DEFAULT_OPTIONS, linearBrightness: 1.5, linearContrast: 1.2, linearContrastPivot: 0.25 };
    expect(engineOptions(lin, "video")).toMatchObject({ linear_brightness: 1.5, linear_contrast: 1.2, linear_contrast_pivot: 0.25 });
    // a frame folder: the original ignores the adjust there, so it is never sent
    expect(engineOptions(lin, "frames")).not.toHaveProperty("linear_brightness");
  });
});

describe("TensorRT in the queue", () => {
  it("sends tensorrt: true per job while the app says so, and nothing otherwise", async () => {
    let on = true;
    const h = harness({ tensorrt: () => on });
    h.q.add(job("a"));
    h.q.add(job("b"));
    await h.q.start();
    await h.flush();
    expect((h.sent[0].options as Record<string, unknown>).tensorrt).toBe(true);
    on = false;
    h.reply({ type: "result", id: "a", outputs: [] });
    await h.flush();
    expect(h.sent[1].options).not.toHaveProperty("tensorrt");
  });

  it("puts what really ran into the job's log (provider replies), and nothing for a plain CUDA job", async () => {
    const h = harness({ tensorrt: () => true });
    h.q.add(job("a"));
    await h.q.start();
    await h.flush();
    h.reply({ type: "provider", id: "a", provider: "cuda", precision: "fp16", tensorrt_requested: false });
    h.reply({ type: "provider", id: "a", provider: "tensorrt", precision: "fp16", tensorrt_requested: true, range: "h640-1152_w768-1280_t1-48_f1-4", cache: "build" });
    h.reply({ type: "provider", id: "a", provider: "tensorrt+cuda", pieces: ["rvm", "stage1"], fallbacks: { stage1: "out of graphics memory while building" }, build_s: { rvm: 20.4, stage1: 0 } });
    expect(h.q.jobs[0].log).toEqual([
      "TensorRT: building the engines for this resolution (h640-1152_w768-1280_t1-48_f1-4), once.",
      "Runs on TensorRT (engines built in 20 s, kept for this resolution); on CUDA: stage1 (out of graphics memory while building).",
    ]);
  });

  it("says why TensorRT wasn't used", () => {
    expect(providerText({ type: "provider", provider: "cuda", tensorrt_requested: true, fallback_reason: "the models folder has no TensorRT-ready models" })).toBe(
      "TensorRT not used: the models folder has no TensorRT-ready models. Runs on CUDA.",
    );
    expect(providerText({ type: "provider", provider: "tensorrt", fallbacks: {}, build_s: {} })).toBe("Runs on TensorRT.");
  });

  it("keeps what ran the job from both provider replies, and why the app didn't ask for TensorRT", async () => {
    const h = harness({ tensorrt: () => true });
    h.q.add(job("a"));
    await h.q.start();
    await h.flush();
    expect(h.q.jobs[0].tech).toMatchObject({ provider: null, notAsked: null });
    h.reply({ type: "provider", id: "a", provider: "tensorrt", precision: "fp16", tensorrt_requested: true, range: "h1792-2176_w3584-4096_t1-8_f1-4", cache: "reused" });
    h.reply({ type: "provider", id: "a", provider: "tensorrt+cuda", pieces: {}, fallbacks: { stage1: "no tactic" }, build_s: {} });
    expect(h.q.jobs[0].tech).toEqual({
      provider: "tensorrt+cuda",
      precision: "fp16",
      tensorrtRequested: true,
      fallbackReason: null,
      fallbacks: { stage1: "no tactic" },
      range: "h1792-2176_w3584-4096_t1-8_f1-4",
      cache: "reused",
      notAsked: null,
    });

    // 08_3a, 2026-10-25: the parts weren't installed yet, so the job didn't ask, and the page says why
    const n = harness({ tensorrt: () => false, tensorrtWhyNot: () => "TensorRT's parts weren't installed when the job started (Engine settings, TensorRT)" });
    n.q.add(job("b"));
    await n.q.start();
    await n.flush();
    n.reply({ type: "provider", id: "b", provider: "cuda", precision: "fp16", tensorrt_requested: false });
    expect(n.q.jobs[0].tech).toMatchObject({ provider: "cuda", tensorrtRequested: false, notAsked: "TensorRT's parts weren't installed when the job started (Engine settings, TensorRT)" });
  });

  it("stays on Keying while low-memory mode loads stage 2 (04_5d_fg, 2026-10-25: the page went back to Loading the model)", async () => {
    const h = harness({ tensorrt: () => true });
    h.q.add(job("a"));
    await h.q.start();
    await h.flush();
    // the Rust engine's order for a TensorRT job that builds its engines (low-memory mode, pipeline/mod.rs + keying.rs)
    const order: EngineReply[] = [
      { type: "progress", stage: "probe" },
      { type: "provider", provider: "tensorrt", precision: "fp16", tensorrt_requested: true, range: "h1792-2176_w3584-4096_t1-8_f1-4", cache: "build" },
      { type: "progress", stage: "optimize", detail: "C-RADIO (1/5)" },
      { type: "progress", stage: "optimize", detail: "stage 2 (5/5)" },
      { type: "progress", stage: "load" },
      { type: "provider", provider: "tensorrt", pieces: {}, fallbacks: {}, build_s: { stage2: 57.8 } },
      { type: "progress", stage: "rvm" },
      { type: "progress", stage: "load" },
      { type: "progress", stage: "foundations" },
      { type: "progress", stage: "load" },
      { type: "progress", stage: "keying" },
      { type: "progress", stage: "keying", p: 1, detail: "window 29/29 done" },
      { type: "progress", stage: "load" },
      { type: "frames", done: 80, total: 120 },
    ];
    // loop: NOT-WORTH — a test's fourteen replies
    for (const r of order) h.reply({ ...r, id: "a" });
    expect(h.q.jobs[0].stage).toBe("keying");
    expect(h.q.jobs[0].stageDetail).toBe("window 29/29 done");
  });
});
