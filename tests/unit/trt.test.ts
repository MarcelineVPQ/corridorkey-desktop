import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EngineReply } from "../../electron/main/engine";
import type { EngineHandle } from "../../electron/main/queue";
import { BUILD_RECORD, Prebuilder, rangesOnDisk, recordBuild, removeSize, trtRangeDirs } from "../../electron/main/trtPrebuild";
import { tensorrtWhyNot } from "../../electron/main/install";
import {
  buildFraction,
  builtWindows,
  DEFAULT_TRT_SIZES,
  MEASURED_4K_BUILD_S,
  sanitizeTrtSizes,
  SHAPE_QUANTUM,
  TRT_DIM_RANGES,
  TRT_MAX_AREA,
  TRT_MAX_SIDE,
  TRT_NOT_BUILT,
  trtSizeKey,
  trtSizeRows,
  type TrtSize,
} from "../../src/shared/trt";

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

const K4 = "trt-h1792-2176_w3584-4096";
const KHD = "trt-h1024-1280_w1792-2176";

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

  function rig(opts: { others?: string[] | (() => string[]); built?: string[]; sizes?: TrtSize[] } = {}) {
    const sent: Record<string, unknown>[] = [];
    const sizes: TrtSize[] = opts.sizes ?? DEFAULT_TRT_SIZES.map((x) => ({ ...x }));
    const records: [string, number][] = [];
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
      othersOnGpu: () => Promise.resolve(typeof opts.others === "function" ? opts.others() : (opts.others ?? [])),
      recheckMs: 5,
      built: () => opts.built ?? [],
      sizes: () => sizes,
      recordBuild: (range, secs) => records.push([range, secs]),
      now: () => 0,
    });
    return { b, sent, sizes, records, reply: (r: EngineReply) => reply(r), kills: () => kills, allow: (v: boolean) => (allowed = v) };
  }

  it("builds 4K then HD until other sizes are chosen, moves its bar by network, and is done after both", async () => {
    const r = rig();
    await r.b.start(false);
    expect(r.sent).toEqual([{ cmd: "trt_build", id: K4, width: 4096, height: 2160 }]);
    r.reply({ type: "progress", id: K4, stage: "optimize", piece: "stage1", detail: "stage 1 (4/5)" });
    expect(r.b.state.ranges[0]).toMatchObject({ state: "building", piece: "stage1" });
    expect(r.b.state.fraction).toBeCloseTo(buildFraction("stage1", true) / 2, 6);
    r.reply({ type: "trt_built", id: K4, range: "h1792-2176_w3584-4096_t1-8_f1-4", fallbacks: {}, built_s: { cradio: 36.8, moge: 33.1, rvm: 35.6, stage1: 139.2, stage2: 57.8 } });
    // all five built in this run: its time is recorded (302.5 s)
    expect(r.records).toEqual([["h1792-2176_w3584-4096_t1-8_f1-4", expect.closeTo(302.5, 6)]]);
    expect(r.sent[1]).toEqual({ cmd: "trt_build", id: KHD, width: 1920, height: 1080 });
    r.reply({ type: "trt_built", id: KHD, range: "h1024-1280_w1792-2176_t1-48_f1-4", fallbacks: { stage1: "no tactic" }, built_s: { stage2: 50 } });
    expect(r.b.state).toMatchObject({ status: "done", fraction: 1 });
    // a part of the networks built (resumed, or reused): no time recorded, it wouldn't be the whole build
    expect(r.records).toHaveLength(1);
    expect(r.b.state.ranges[1].fallbacks).toEqual({ stage1: "no tactic" });
  });

  it("gives way to the queue and goes on after it; never starts by itself while another program uses the card", async () => {
    const r = rig({ built: ["h1792-2176_w3584-4096_t1-8_f1-4"] });
    // 4K already built: only HD is built
    await r.b.start(false);
    expect(r.sent).toEqual([{ cmd: "trt_build", id: KHD, width: 1920, height: 1080 }]);
    r.b.pause();
    expect(r.kills()).toBe(1);
    expect(r.b.state).toMatchObject({ status: "paused" });
    expect(r.b.state.ranges[1].state).toBe("todo");
    r.b.queueStopped();
    await new Promise((res) => setTimeout(res, 0));
    expect(r.sent.at(-1)).toEqual({ cmd: "trt_build", id: KHD, width: 1920, height: 1080 });
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

  it("held back by another program on the card (Sonata), it looks again and starts by itself once the card is free", async () => {
    let others = ["Sonata"];
    const r = rig({ others: () => others });
    await r.b.start(false);
    expect(r.b.state.status).toBe("blocked");
    await new Promise((res) => setTimeout(res, 20));
    expect(r.sent).toEqual([]);
    others = [];
    await new Promise((res) => setTimeout(res, 20));
    expect(r.sent).toEqual([{ cmd: "trt_build", id: K4, width: 4096, height: 2160 }]);
    // stopped while blocked: no more looks
    const s = rig({ others: ["Sonata"] });
    await s.b.start(false);
    s.b.stop();
    await new Promise((res) => setTimeout(res, 20));
    expect(s.b.state.status).toBe("stopped");
  });

  it("builds the chosen sizes, takes a size chosen while it builds after the others, and waits for a running queue", async () => {
    const r = rig({ sizes: [{ label: "shot_010", width: 2560, height: 1440 }] });
    await r.b.start(true);
    expect(r.sent).toEqual([{ cmd: "trt_build", id: "trt-h1408-1664_w2304-2816", width: 2560, height: 1440 }]);
    r.reply({ type: "progress", id: "trt-h1408-1664_w2304-2816", stage: "optimize", piece: "rvm" });
    r.sizes.push({ label: "HD", width: 1920, height: 1080 });
    r.b.refresh();
    // the range building keeps its state; the new one waits its turn
    expect(r.b.state.ranges.map((x) => [x.label, x.state, x.piece])).toEqual([
      ["shot_010", "building", "rvm"],
      ["HD", "todo", null],
    ]);
    r.reply({ type: "trt_built", id: "trt-h1408-1664_w2304-2816", range: "h1408-1664_w2304-2816_t1-24_f1-4", fallbacks: {} });
    expect(r.sent.at(-1)).toEqual({ cmd: "trt_build", id: KHD, width: 1920, height: 1080 });

    const q = rig({ sizes: [{ label: "HD", width: 1920, height: 1080 }] });
    q.b.waitForQueue();
    expect(q.b.state.status).toBe("paused");
    q.b.queueStopped();
    await new Promise((res) => setTimeout(res, 0));
    expect(q.sent).toEqual([{ cmd: "trt_build", id: KHD, width: 1920, height: 1080 }]);
  });

  it("reads each built range's disk size and recorded build time, records a build, removes a size", () => {
    const root = join(ROOT, "sizes");
    const make = (card: string, range: string) => {
      const dir = join(root, card, range);
      // loop: NOT-WORTH — five networks in a test
      for (const p of ["cradio", "moge", "rvm", "stage1", "stage2"]) {
        mkdirSync(join(dir, p), { recursive: true });
        writeFileSync(join(dir, p, `${p}_ctx.onnx`), "x");
      }
      return dir;
    };
    const hd = make("rtx-5080__drv615", "h1024-1280_w1792-2176_t1-48_f1-4");
    make("rtx-5080__drv615", "h1792-2176_w3584-4096_t1-8_f1-4");
    const bytes = () => 2_500_000_000;
    expect(rangesOnDisk(root, bytes)).toEqual([
      { range: "h1024-1280_w1792-2176_t1-48_f1-4", bytes: 2_500_000_000, buildSeconds: null },
      { range: "h1792-2176_w3584-4096_t1-8_f1-4", bytes: 2_500_000_000, buildSeconds: null },
    ]);
    recordBuild(root, "h1024-1280_w1792-2176_t1-48_f1-4", 270.7);
    expect(JSON.parse(readFileSync(join(hd, BUILD_RECORD), "utf8")).seconds).toBe(270.7);
    expect(rangesOnDisk(root, bytes)[0].buildSeconds).toBe(270.7);
    // the record doesn't make an unbuilt folder count as built, and the engine's networks are all it checks
    expect(trtRangeDirs(root).every((d) => d.built)).toBe(true);
    removeSize(root, "h1024-1280_w1792-2176");
    expect(trtRangeDirs(root).map((d) => d.range)).toEqual(["h1792-2176_w3584-4096_t1-8_f1-4"]);
  });
});

describe("choosing the sizes TensorRT builds for", () => {
  it("groups the named sizes by range, adds chosen and built ones, and names those past TensorRT's sizes", () => {
    const { rows, outside } = trtSizeRows([{ label: "shot_010", width: 2560, height: 1440 }], ["h128-512_w128-512_t1-80_f1-4"]);
    // loop: NOT-WORTH — a dozen rows in a test
    expect(rows.map((r) => [r.key, r.sizes.map((x) => x.label), r.build.label])).toEqual([
      ["h640-896_w1024-1280", ["720p"], "720p"],
      ["h1024-1280_w1792-2176", ["HD", "2K DCI"], "HD"],
      ["h1408-1664_w1792-2176", ["2K full aperture"], "2K full aperture"],
      ["h1408-1664_w2944-3456", ["2.8K"], "2.8K"],
      ["h1792-2176_w3584-4096", ["4K DCI", "UHD"], "4K DCI"],
      ["h1408-1664_w2304-2816", ["shot_010"], "shot_010"],
      ["h128-512_w128-512", ["Built earlier"], "Built earlier"],
    ]);
    // loop: NOT-WORTH — two sizes in a test
    expect(outside.map((x) => x.label)).toEqual(["4K open gate", "6K"]);
    // a chosen size in a named row is the size that row builds
    expect(trtSizeRows([{ label: "plate", width: 1998, height: 1080 }], []).rows[1]).toMatchObject({ sizes: [{ label: "HD" }, { label: "2K DCI" }, { label: "plate" }], build: { label: "plate" } });
  });

  it("reads the setting: 4K DCI and HD when absent; checked sizes, one per range, inside TensorRT's sizes", () => {
    expect(sanitizeTrtSizes(undefined)).toEqual(DEFAULT_TRT_SIZES);
    expect(
      sanitizeTrtSizes([
        { label: "HD", width: 1920, height: 1080 },
        { label: "2K DCI", width: 2048, height: 1080 },
        { label: "6K", width: 6144, height: 3240 },
        { label: "", width: 100, height: 100 },
        { label: "odd", width: 1000.5, height: 500 },
        "junk",
      ]),
    ).toEqual([{ label: "HD", width: 1920, height: 1080 }]);
    expect(sanitizeTrtSizes([])).toEqual([]);
  });
});
