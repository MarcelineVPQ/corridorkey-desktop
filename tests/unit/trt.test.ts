import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EngineReply } from "../../electron/main/engine";
import type { EngineHandle } from "../../electron/main/queue";
import { Prebuilder, trtRangeDirs } from "../../electron/main/trtPrebuild";
import { tensorrtWhyNot } from "../../electron/main/install";
import { buildFraction, builtWindows, MEASURED_4K_BUILD_S, SHAPE_QUANTUM, TRT_DIM_RANGES, TRT_MAX_AREA, TRT_MAX_SIDE, TRT_NOT_BUILT, trtSizeKey } from "../../src/shared/trt";

const rs = (f: string) => readFileSync(join(__dirname, "..", "..", "engine-rs", "crates", "ck-core", "src", f), "utf8");

describe("TensorRT ranges as the engine has them", () => {
  it("mirrors tensorrt.rs, clip.rs and the engine's not-built reason exactly", () => {
    const trt = rs("tensorrt.rs");
    const ranges = /DIM_RANGES: \[\(usize, usize\); \d+\] = \[([^\]]+)\]/.exec(trt)![1];
    // loop: NOT-WORTH — eight pairs in a test
    expect([...ranges.matchAll(/\((\d+), (\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2])])).toEqual(TRT_DIM_RANGES);
    expect(Number(/const MAX_SIDE: usize = (\d+);/.exec(trt)![1])).toBe(TRT_MAX_SIDE);
    expect(
      /const MAX_AREA: usize = (\d+) \* (\d+);/
        .exec(trt)!
        .slice(1)
        .map(Number)
        .reduce((a, b) => a * b),
    ).toBe(TRT_MAX_AREA);
    expect(Number(/const SHAPE_QUANTUM: usize = (\d+);/.exec(rs("clip.rs"))![1])).toBe(SHAPE_QUANTUM);
    expect(rs("pipeline/mod.rs")).toContain(`const TRT_NOT_BUILT: &str = "${TRT_NOT_BUILT}";`);
  });

  it("puts a clip's size in its range (the engine's keys), or none", () => {
    expect(trtSizeKey(4096, 2160)).toBe("h1792-2176_w3584-4096");
    expect(trtSizeKey(3840, 2160)).toBe("h1792-2176_w3584-4096");
    expect(trtSizeKey(1920, 1080)).toBe("h1024-1280_w1792-2176");
    expect(trtSizeKey(4096, 3072)).toBeNull(); // open gate: past MAX_AREA, CUDA
    expect(builtWindows("h1792-2176_w3584-4096", ["h1792-2176_w3584-4096_t1-8_f1-4", "h1024-1280_w1792-2176_t1-48_f1-4"])).toEqual([8]);
  });

  it("weights the 4K progress by the measured build times, other sizes one share per network", () => {
    expect(buildFraction("cradio", true)).toBe(0);
    const total = Object.values(MEASURED_4K_BUILD_S).reduce((a, b) => a + b, 0);
    expect(buildFraction("stage1", true)).toBeCloseTo((36.8 + 33.1 + 35.6) / total, 6);
    expect(buildFraction("stage1", false)).toBeCloseTo(3 / 5, 6);
  });
});

describe("why a job doesn't ask for TensorRT", () => {
  const yes = { platform: "linux" as const, setting: true, engine: "rust" as const, ready: true };
  it("names the setting, the engine or the parts, and nothing where TensorRT doesn't exist", () => {
    expect(tensorrtWhyNot(yes)).toBeNull();
    expect(tensorrtWhyNot({ ...yes, setting: false })).toMatch(/off/);
    expect(tensorrtWhyNot({ ...yes, engine: "python" })).toMatch(/ONNX Runtime engine only/);
    // 08_3a, 2026-10-25: the parts arrived 1.5 minutes after the job ended
    expect(tensorrtWhyNot({ ...yes, ready: false })).toMatch(/parts weren't installed/);
    expect(tensorrtWhyNot({ ...yes, platform: "win32", setting: false })).toBeNull();
  });
});

const ROOT = mkdtempSync(join(tmpdir(), "ck-trt-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("the background TensorRT build", () => {
  it("reads which ranges are built: every network built or remembered as failing, one level under the card", () => {
    const range = join(ROOT, "rtx-5080__drv615__fp16", "h1792-2176_w3584-4096_t1-8_f1-4");
    // loop: NOT-WORTH — five networks in a test
    for (const p of ["cradio", "moge", "rvm", "stage2"]) {
      mkdirSync(join(range, p), { recursive: true });
      writeFileSync(join(range, p, `${p}_ctx.onnx`), "");
    }
    mkdirSync(join(range, "stage1"), { recursive: true });
    expect(trtRangeDirs(ROOT)).toEqual([{ range: "h1792-2176_w3584-4096_t1-8_f1-4", dir: range, built: false }]);
    writeFileSync(join(range, "stage1", "stage1.failed"), "stamp\n8192\nno tactic\n");
    expect(trtRangeDirs(ROOT)[0].built).toBe(true);
    expect(trtRangeDirs(join(ROOT, "missing"))).toEqual([]);
  });

  function rig(opts: { others?: string[]; built?: string[] } = {}) {
    const sent: Record<string, unknown>[] = [];
    let reply: (r: EngineReply) => void = () => {};
    let kills = 0;
    let allowed = true;
    const b = new Prebuilder({
      makeEngine: (onReply) => {
        reply = onReply;
        const h: EngineHandle = {
          running: true,
          start: () => Promise.resolve({ type: "pong" }),
          send: (m) => sent.push(m),
          quit: () => {},
          kill: () => kills++,
          stderrTail: () => [],
        };
        return h;
      },
      changed: () => {},
      allowed: () => allowed,
      othersOnGpu: () => Promise.resolve(opts.others ?? []),
      built: () => opts.built ?? [],
      now: () => 0,
    });
    return { b, sent, reply: (r: EngineReply) => reply(r), kills: () => kills, allow: (v: boolean) => (allowed = v) };
  }

  it("builds 4K then HD, moves its bar by network, and is done after both", async () => {
    const r = rig();
    await r.b.start(false);
    expect(r.sent).toEqual([{ cmd: "trt_build", id: "trt-4K", width: 4096, height: 2160 }]);
    r.reply({ type: "progress", id: "trt-4K", stage: "optimize", piece: "stage1", detail: "stage 1 (4/5)" });
    expect(r.b.state.ranges[0]).toMatchObject({ state: "building", piece: "stage1" });
    expect(r.b.state.fraction).toBeCloseTo(buildFraction("stage1", true) / 2, 6);
    r.reply({ type: "trt_built", id: "trt-4K", range: "h1792-2176_w3584-4096_t1-8_f1-4", fallbacks: {} });
    expect(r.sent[1]).toEqual({ cmd: "trt_build", id: "trt-HD", width: 1920, height: 1080 });
    r.reply({ type: "trt_built", id: "trt-HD", range: "h1024-1280_w1792-2176_t1-48_f1-4", fallbacks: { stage1: "no tactic" } });
    expect(r.b.state).toMatchObject({ status: "done", fraction: 1 });
    expect(r.b.state.ranges[1].fallbacks).toEqual({ stage1: "no tactic" });
  });

  it("gives way to the queue and goes on after it; never starts by itself while another program uses the card", async () => {
    const r = rig({ built: ["h1792-2176_w3584-4096_t1-8_f1-4"] });
    // 4K already built: only HD is built
    await r.b.start(false);
    expect(r.sent).toEqual([{ cmd: "trt_build", id: "trt-HD", width: 1920, height: 1080 }]);
    r.b.pause();
    expect(r.kills()).toBe(1);
    expect(r.b.state).toMatchObject({ status: "paused" });
    expect(r.b.state.ranges[1].state).toBe("todo");
    r.b.queueStopped();
    await new Promise((res) => setTimeout(res, 0));
    expect(r.sent.at(-1)).toEqual({ cmd: "trt_build", id: "trt-HD", width: 1920, height: 1080 });
    r.b.stop();
    expect(r.b.state.status).toBe("stopped");

    const s = rig({ others: ["Sonata"] });
    await s.b.start(false);
    expect(s.sent).toEqual([]);
    expect(s.b.state).toMatchObject({ status: "blocked", note: "Sonata is using the graphics card" });
    // Build now: the user's choice
    await s.b.start(true);
    expect(s.sent).toHaveLength(1);
  });
});
