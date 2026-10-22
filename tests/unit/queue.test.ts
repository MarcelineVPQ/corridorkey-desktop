import { describe, expect, it } from "vitest";
import { engineOptions, Queue, type EngineHandle } from "../../electron/main/queue";
import type { EngineReply } from "../../electron/main/engine";
import { DEFAULT_OPTIONS, type Job } from "../../src/shared/types";

function job(id: string, extra: Partial<Job> = {}): Job {
  return {
    id,
    clip: { path: `/c/${id}.mp4`, name: id, kind: "video", width: 640, height: 360, fps: 24, frames: 24, thumb: null, companionFirstFrame: null, companionHintVideo: null, probeError: null },
    options: { ...DEFAULT_OPTIONS },
    outputDir: `/c/out_${id}`,
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
    log: [],
    ...extra,
  };
}

function harness(opts: { pongProtocol?: number; failStart?: boolean } = {}) {
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
      const h: EngineHandle = {
        running: true,
        pid: 4242,
        start: () =>
          opts.failStart ? Promise.reject(new Error("no python")) : Promise.resolve({ type: "pong", protocol: opts.pongProtocol ?? 1, version: "0.1.0", engine: "pytorch", device: "cuda" }),
        send: (m) => sent.push(m),
        quit: () => quits++,
        kill: () => killed++,
        stderrTail: () => ["trace line"],
      };
      engines.push(h);
      return h;
    },
    tempDirFor: (id) => `/nonexistent-ck-test/${id}`,
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
    h.reply({ type: "result", id: "a", outputs: ["/c/out_a/a_alpha.mp4"] });
    await h.flush();
    expect(h.q.jobs[0].status).toBe("done");
    expect(h.q.jobs[0].outputs).toEqual(["/c/out_a/a_alpha.mp4"]);
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

describe("engineOptions", () => {
  it("sends a manual window only in manual mode and hints only for their mode", () => {
    const auto = engineOptions({ ...DEFAULT_OPTIONS, hintMode: "none", hintFirstFrame: "/h.png" }, "video");
    expect(auto).not.toHaveProperty("hann_chunk");
    expect(auto).not.toHaveProperty("hint_first_frame");
    const manual = engineOptions({ ...DEFAULT_OPTIONS, hintMode: "first-frame", hintFirstFrame: "/h.png", memory: { auto: false, hannChunk: 8, hannStride: 4, lowVram: true } }, "frames");
    expect(manual).toMatchObject({ hann_chunk: 8, hann_stride: 4, low_vram: true, hint_first_frame: "/h.png", frame_dir_fps: 24 });
  });
});
