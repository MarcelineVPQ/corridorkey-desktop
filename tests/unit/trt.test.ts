import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { EngineReply } from "../../electron/main/engine";
import type { EngineHandle } from "../../electron/main/queue";
import { BUILD_RECORD, builtRanges, Prebuilder, rangesOnDisk, recordBuild, removeSize, sourceStamp, trtRangeDirs, trtStamps, type BuildItem } from "../../electron/main/trtPrebuild";
import { tensorrtWhyNot } from "../../electron/main/install";
import {
  buildSteps,
  buildTotals,
  builtWindows,
  DEFAULT_TRT_SIZES,
  ownTrtSize,
  sanitizeTrtSize,
  sanitizeTrtSizes,
  SHAPE_QUANTUM,
  TRT_DIM_RANGES,
  TRT_MAX_AREA,
  TRT_MAX_SIDE,
  TRT_BUILD_CAP,
  TRT_NOT_BUILT,
  TRT_OTHER_WINDOW,
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
    expect(rs("pipeline/mod.rs")).toContain(`format!("${TRT_OTHER_WINDOW} {}`);
    expect(rs("pipeline/mod.rs")).toContain(`const TRT_BUILD_CAP: &str = "${TRT_BUILD_CAP}";`);
  });

  it("puts a clip's size in its range (the engine's keys), or none", () => {
    expect(trtSizeKey(4096, 2160)).toBe("h1792-2176_w3584-4096");
    expect(trtSizeKey(3840, 2160)).toBe("h1792-2176_w3584-4096");
    expect(trtSizeKey(1920, 1080)).toBe("h1024-1280_w1792-2176");
    expect(trtSizeKey(4096, 3072)).toBeNull(); // open gate: past MAX_AREA, CUDA
    expect(builtWindows("h1792-2176_w3584-4096", ["h1792-2176_w3584-4096_t1-8_f1-4", "h1024-1280_w1792-2176_t1-48_f1-4"])).toEqual([8]);
  });

  it("whole review S7: the build's progress on screen is the engine's networks, never the time-weighted fraction", () => {
    const ranges = [
      { state: "done", piece: null },
      { state: "building", piece: "stage1" },
      { state: "todo", piece: null },
    ];
    expect(buildSteps(ranges)).toEqual({ done: 5 + 3, total: 15 });
    expect(buildSteps([{ state: "building", piece: null }])).toEqual({ done: 0, total: 5 });
    // loop: NOT-WORTH — three source files, once
    for (const f of ["setup/SetupParts.tsx", "pages/EnginePage.tsx", "JobView.tsx"]) expect(readFileSync(new URL(`../../src/ui/${f}`, import.meta.url), "utf8")).not.toMatch(/\.fraction\b/);
  });
});

describe("why a job doesn't ask for TensorRT", () => {
  const yes = { platform: "linux" as const, setting: true, ready: true };
  it("names the setting or the parts, and nothing where TensorRT doesn't exist", () => {
    expect(tensorrtWhyNot(yes)).toBeNull();
    expect(tensorrtWhyNot({ ...yes, setting: false })).toMatch(/off/);
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
  it("reads which ranges are built: every network built or remembered as failing, one level under the card", async () => {
    const range = join(ROOT, "rtx-5080__drv615__fp16", "h1792-2176_w3584-4096_t1-8_f1-4");
    const stamps = new Map(["cradio", "moge", "rvm", "stage1", "stage2"].map((p) => [p, `s-${p}`]));
    // loop: NOT-WORTH — five networks in a test
    for (const p of ["cradio", "moge", "rvm", "stage2"]) {
      mkdirSync(join(range, p), { recursive: true });
      // loop: NOT-WORTH — three files a network
      for (const [f, text] of [
        [`${p}.engine`, ""],
        [`${p}_ctx.onnx`, ""],
        [`${p}.source`, `s-${p}\n`],
      ])
        writeFileSync(join(range, p, f), text);
    }
    mkdirSync(join(range, "stage1"), { recursive: true });
    expect(await trtRangeDirs(ROOT, stamps)).toEqual([{ range: "h1792-2176_w3584-4096_t1-8_f1-4", dir: range, built: false, stale: false }]);
    // a failed build is remembered for the export it failed from (tensorrt.rs failed_before): another one builds again
    writeFileSync(join(range, "stage1", "stage1.failed"), "s-old\n8192\nno tactic\n");
    expect((await trtRangeDirs(ROOT, stamps))[0]).toMatchObject({ built: false, stale: true });
    writeFileSync(join(range, "stage1", "stage1.failed"), "s-stage1\n8192\nno tactic\n");
    expect((await trtRangeDirs(ROOT, stamps))[0]).toMatchObject({ built: true, stale: false });
    // only the networks the models folder has a TensorRT-ready export of count (runtime.rs trt_file)
    rmSync(join(range, "stage2"), { recursive: true });
    expect((await trtRangeDirs(ROOT, stamps))[0].built).toBe(false);
    stamps.delete("stage2");
    expect((await trtRangeDirs(ROOT, stamps))[0].built).toBe(true);
    // no models folder to read: nothing is called built (the storage list and removals only list the folders)
    expect((await trtRangeDirs(ROOT))[0]).toMatchObject({ built: false, stale: false });
    expect(await trtRangeDirs(join(ROOT, "missing"), stamps)).toEqual([]);
    rmSync(join(ROOT, "rtx-5080__drv615__fp16"), { recursive: true });
  });

  it("2026-10-29: a range built from another model set's TensorRT files is stale, as the engine says, not built", async () => {
    // Marcy's 4K and HD engines were built from onnx.4's files; the app runs onnx.5, every job said "isn't built yet"
    const root = join(ROOT, "stale");
    const set = (name: string, mtime: number) => {
      const dir = join(root, "models", name);
      const files: Record<string, string> = {};
      mkdirSync(dir, { recursive: true });
      // loop: NOT-WORTH — five networks in a test
      for (const p of ["cradio", "moge", "rvm", "stage1", "stage2"]) {
        files[p] = `ck2-${p}-trt-fp16.onnx`;
        // loop: NOT-WORTH — the export and its weights
        for (const f of [files[p], `${files[p]}.data`]) {
          writeFileSync(join(dir, f), "weights");
          utimesSync(join(dir, f), mtime, mtime);
        }
      }
      writeFileSync(join(dir, "models.json"), JSON.stringify({ "tensorrt-fp16": files }));
      return dir;
    };
    const onnx4 = set("2.0.0-onnx.4", 1792943067);
    const onnx5 = set("2.0.0-onnx.5", 1793201341);
    const cache = join(root, "tensorrt");
    const range = join(cache, "rtx-5080__drv615__fp16", "h1792-2176_w3584-4096_t1-8_f1-4");
    // built by the engine from onnx.4 (its stamp in each network's .source)
    const old = (await trtStamps(onnx4))!;
    // loop: NOT-WORTH — five networks in a test
    for (const [p, stamp] of old) {
      mkdirSync(join(range, p), { recursive: true });
      // loop: NOT-WORTH — three files a network
      for (const [f, text] of [
        [`${p}.engine`, "engine"],
        [`${p}_ctx.onnx`, "stub"],
        [`${p}.source`, stamp],
      ])
        writeFileSync(join(range, p, f), text);
    }
    const now = (await trtStamps(onnx5))!;
    expect(now.get("cradio")).toBe(`7:1793201341,7:1793201341`);
    expect(await builtRanges(cache, now)).toEqual([]);
    expect(await rangesOnDisk(cache, now, async () => 2_500_000_000)).toEqual([{ range: "h1792-2176_w3584-4096_t1-8_f1-4", bytes: 2_500_000_000, buildSeconds: null, stale: true }]);
    // the set it was built from: built
    expect(await builtRanges(cache, old)).toEqual(["h1792-2176_w3584-4096_t1-8_f1-4"]);
    expect((await rangesOnDisk(cache, old, async () => 1))[0].stale).toBe(false);
    // no models folder, or one whose models.json can't be read (the engine doesn't start): nothing built
    expect(await trtStamps(null)).toBeNull();
    writeFileSync(join(onnx5, "models.json"), "{");
    expect(await trtStamps(onnx5)).toBeNull();
  });

  it("stamps an export as the engine does (tensorrt.rs source_stamp, its test's two strings)", async () => {
    const dir = join(ROOT, "stamp");
    mkdirSync(dir, { recursive: true });
    const onnx = join(dir, "x.onnx");
    writeFileSync(onnx, "abc");
    // 0.9 s into the second: floored, as Rust's as_secs
    utimesSync(onnx, 1792943067.9, 1792943067.9);
    const noData = await sourceStamp(onnx);
    writeFileSync(`${onnx}.data`, "hello");
    utimesSync(`${onnx}.data`, 1792943067.9, 1792943067.9);
    const withData = await sourceStamp(onnx);
    expect([noData, withData]).toEqual(["3:1792943067,-", "3:1792943067,5:1792943067"]);
    const test = rs("tensorrt.rs");
    expect(test).toContain(`assert_eq!(source_stamp(&onnx), "${noData}");`);
    expect(test).toContain(`assert_eq!(source_stamp(&onnx), "${withData}");`);
  });

  function rig(opts: { others?: string[] | (() => string[] | Promise<string[]>); built?: string[]; sizes?: BuildItem[] } = {}) {
    const sent: Record<string, unknown>[] = [];
    const sizes: BuildItem[] = opts.sizes ?? DEFAULT_TRT_SIZES.map((x) => ({ ...x }));
    const records: [string, number][] = [];
    let reply: (r: EngineReply) => void = () => {};
    let kills = 0;
    let allowed = true;
    let queue = false;
    let last: { running: boolean } | null = null;
    const b = new Prebuilder({
      makeEngine: (onReply) => {
        reply = onReply;
        const h: EngineHandle & { running: boolean } = {
          running: true,
          start: () => Promise.resolve({ type: "pong" }),
          send: (m) => sent.push(m),
          quit: () => {},
          kill: () => kills++,
          stderrTail: () => [],
        };
        last = h;
        return h;
      },
      changed: () => {},
      allowed: () => allowed,
      queueRunning: () => queue,
      othersOnGpu: () => Promise.resolve(typeof opts.others === "function" ? opts.others() : (opts.others ?? [])),
      recheckMs: 5,
      built: () => opts.built ?? [],
      sizes: () => sizes,
      recordBuild: (range, secs) => records.push([range, secs]),
      now: () => 0,
    });
    return { b, sent, sizes, records, reply: (r: EngineReply) => reply(r), kills: () => kills, engine: () => last, allow: (v: boolean) => (allowed = v), queue: (v: boolean) => (queue = v) };
  }

  it("builds 4K then HD until other sizes are chosen, reports the network it builds, and is done after both", async () => {
    const r = rig();
    await r.b.start(false);
    expect(r.sent).toEqual([{ cmd: "trt_build", id: K4, width: 4096, height: 2160 }]);
    r.reply({ type: "progress", id: K4, stage: "optimize", piece: "stage1", detail: "stage 1 (4/5)" });
    expect(r.b.state.ranges[0]).toMatchObject({ state: "building", piece: "stage1" });
    r.reply({ type: "trt_built", id: K4, range: "h1792-2176_w3584-4096_t1-8_f1-4", fallbacks: {}, built_s: { cradio: 36.8, moge: 33.1, rvm: 35.6, stage1: 139.2, stage2: 57.8 } });
    // all five built in this run: its time is recorded (302.5 s)
    expect(r.records).toEqual([["h1792-2176_w3584-4096_t1-8_f1-4", expect.closeTo(302.5, 6)]]);
    expect(r.sent[1]).toEqual({ cmd: "trt_build", id: KHD, width: 1920, height: 1080 });
    r.reply({ type: "trt_built", id: KHD, range: "h1024-1280_w1792-2176_t1-48_f1-4", fallbacks: { stage1: "no tactic" }, built_s: { stage2: 50 } });
    expect(r.b.state).toMatchObject({ status: "done" });
    // a part of the networks built (resumed, or reused): no time recorded, it wouldn't be the whole build
    expect(r.records).toHaveLength(1);
    expect(r.b.state.ranges[1].fallbacks).toEqual({ stage1: "no tactic" });
  });

  it("2026-10-30, the checklist: each ticked window builds its own range with its window, done when that range is built", async () => {
    const k4 = (t: number, f: number) => `h1792-2176_w3584-4096_t1-${t}_f1-${f}`;
    // Marcy's card: 4K built for 2 and 8; the job at window 4 ran on CUDA. Ticked: 2 (built) and 4
    const r = rig({
      built: [k4(2, 2), k4(8, 4)],
      sizes: [
        { label: "4K DCI", width: 4096, height: 2160, window: 2, range: k4(2, 2) },
        { label: "4K DCI", width: 4096, height: 2160, window: 4, range: k4(4, 4) },
      ],
    });
    await r.b.start(true);
    expect(r.sent).toEqual([{ cmd: "trt_build", id: `${K4}-t4`, width: 4096, height: 2160, window: 4 }]);
    r.reply({ type: "trt_built", id: `${K4}-t4`, range: k4(4, 4), fallbacks: {}, built_s: {} });
    expect(r.b.state.status).toBe("done");
    // nothing ticked: nothing builds
    const none = rig({ sizes: [] });
    await none.b.start(false);
    expect([none.sent, none.b.state.status]).toEqual([[], "done"]);
  });

  it("says while the engine pause() killed hasn't exited (the Console's corridorkey waits for it; senior review 2026-10-26 N9)", async () => {
    const r = rig();
    await r.b.start(false);
    expect(r.b.engineEnding).toBe(false);
    r.b.pause();
    expect(r.b.engineEnding).toBe(true);
    r.engine()!.running = false;
    expect(r.b.engineEnding).toBe(false);
  });

  it("says so too while the engine the build's end quit hasn't exited (review 2026-10-27)", async () => {
    const r = rig({ built: ["h1792-2176_w3584-4096_t1-8_f1-4"] });
    await r.b.start(false);
    r.reply({ type: "trt_built", id: KHD, range: "h1024-1280_w1792-2176_t1-48_f1-4", fallbacks: {} });
    expect(r.b.state.status).toBe("done");
    expect(r.b.engineEnding).toBe(true);
    r.engine()!.running = false;
    expect(r.b.engineEnding).toBe(false);
  });

  it("1.0.0-dev.7: a job's Build it now builds its size now, even where a range of that size is built (for shorter windows only)", async () => {
    // HD was built at window 2 during other GPU use; a job at window 4 ran on CUDA and offered to build it
    const r = rig({ built: ["h1792-2176_w3584-4096_t1-8_f1-4", "h1024-1280_w1792-2176_t1-2_f1-2"], others: ["Sonata"] });
    await r.b.start(false);
    expect(r.sent).toEqual([]);
    // the button: started as the user's own Build now (another program on the card doesn't hold it back)
    await r.b.buildSize("h1024-1280_w1792-2176");
    expect(r.sent).toEqual([{ cmd: "trt_build", id: KHD, width: 1920, height: 1080 }]);
    r.reply({ type: "trt_built", id: KHD, range: "h1024-1280_w1792-2176_t1-24_f1-4", fallbacks: {} });
    expect(r.b.state.status).toBe("done");
    // once built, it is done again: the next start doesn't build it a second time
    r.b.refresh();
    await r.b.start(true);
    expect(r.sent).toHaveLength(1);
  });

  it("review 2026-10-29: a build that ran short of memory stays failed (its reason on screen) until a build is asked again, which retries it", async () => {
    let others = ["Sonata"];
    const r = rig({ built: ["h1792-2176_w3584-4096_t1-8_f1-4", "h1024-1280_w1792-2176_t1-2_f1-2"], others: () => others });
    await r.b.buildSize("h1024-1280_w1792-2176");
    const why = "the graphics card didn't have enough memory to build stage 1 for 1920×1080";
    r.reply({ type: "error", id: KHD, code: "oom", message: why });
    expect(r.b.state).toMatchObject({ status: "error" });
    // after the next job (a refresh with no build running), an older range of the size made it "done" again
    r.b.refresh();
    expect(r.b.state.status).toBe("error");
    // the program on the card when it started is named, and building again stays offered (N-N5)
    const named = `${why} (Sonata was using the graphics card when it started)`;
    expect(r.b.state.ranges.find((x) => x.width === 1920)).toMatchObject({ state: "failed", error: named, cardWasFree: false });
    // the one click: built again
    others = [];
    await r.b.buildSize("h1024-1280_w1792-2176");
    expect(r.sent.filter((m) => m.id === KHD)).toHaveLength(2);
    // review 2026-10-29 N-N5: short of memory again with nothing else on the card: no other program is blamed, and the
    // job's page offers no build that would meet the same card
    r.reply({ type: "error", id: KHD, code: "oom", message: why });
    expect(r.b.state.ranges.find((x) => x.width === 1920)).toMatchObject({ state: "failed", error: why, cardWasFree: true });
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
    // loop: NOT-WORTH — vi.waitFor polls one array for the restart [bounded: 2 s]
    await vi.waitFor(() => expect(r.sent.at(-1)).toEqual({ cmd: "trt_build", id: KHD, width: 1920, height: 1080 }), { timeout: 2000 });
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
    // loop: NOT-WORTH — a fixed wait is right here: nothing may start while the card is taken (four 5 ms looks)
    await new Promise((res) => setTimeout(res, 20));
    expect(r.sent).toEqual([]);
    others = [];
    // loop: NOT-WORTH — vi.waitFor polls one array for the next look's start [bounded: 2 s]
    await vi.waitFor(() => expect(r.sent).toEqual([{ cmd: "trt_build", id: K4, width: 4096, height: 2160 }]), { timeout: 2000 });
    // stopped while blocked: no more looks
    const s = rig({ others: ["Sonata"] });
    await s.b.start(false);
    s.b.stop();
    // loop: NOT-WORTH — a fixed wait is right here: no look may undo the stop (four 5 ms looks' time)
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
    // loop: NOT-WORTH — vi.waitFor polls one array for the restart [bounded: 2 s]
    await vi.waitFor(() => expect(q.sent).toEqual([{ cmd: "trt_build", id: KHD, width: 1920, height: 1080 }]), { timeout: 2000 });
  });

  // bug hunt 2026-10-26 P2: started while the queue ran (TensorRT's download ending, the switch, Build now, a size
  // ticked), the build did nothing and never went on after the queue (only a build already paused did)
  it("waits for a running queue whatever starts it (the download's end, the switch, Build now) and goes on after it", async () => {
    const r = rig();
    r.queue(true);
    await r.b.start(false);
    expect(r.sent).toEqual([]);
    expect(r.b.state.status).toBe("paused");
    // Build now while keying: it says it waits (the button did nothing before)
    await r.b.start(true);
    expect(r.sent).toEqual([]);
    expect(r.b.state.status).toBe("paused");
    r.queue(false);
    r.b.queueStopped();
    // loop: NOT-WORTH — vi.waitFor polls one array for the restart [bounded: 2 s]
    await vi.waitFor(() => expect(r.sent).toEqual([{ cmd: "trt_build", id: K4, width: 4096, height: 2160 }]), { timeout: 2000 });
  });

  // bug hunt 2026-10-26 P3: a build held back by Sonata lost its look a minute when a queue ran (pause cleared the timer
  // and left it "blocked"), so it never started by itself again
  it("held back by another program when the queue starts, it looks at the card again after the queue", async () => {
    let others = ["Sonata"];
    const r = rig({ others: () => others });
    await r.b.start(false);
    expect(r.b.state.status).toBe("blocked");
    r.b.pause();
    expect(r.b.state.status).toBe("paused");
    others = [];
    r.b.queueStopped();
    // loop: NOT-WORTH — vi.waitFor polls one array for the restart [bounded: 2 s]
    await vi.waitFor(() => expect(r.sent).toEqual([{ cmd: "trt_build", id: K4, width: 4096, height: 2160 }]), { timeout: 2000 });
  });

  // bug hunt 2026-10-26 P4: Build now pressed while an automatic start read the card did nothing
  it("Build now pressed while an automatic start reads the card starts it whatever the reading says", async () => {
    let answer: (v: string[]) => void = () => {};
    const r = rig({ others: () => new Promise<string[]>((res) => (answer = res)) });
    const auto = r.b.start(false);
    await r.b.start(true);
    answer(["Sonata"]);
    await auto;
    expect(r.sent).toEqual([{ cmd: "trt_build", id: K4, width: 4096, height: 2160 }]);
    expect(r.b.state.status).toBe("running");
  });

  // bug hunt 2026-10-26 P5: removing a size (or moving the cache) stopped a build that was waiting for the queue or for the
  // card for good ("stopped"); only one with an engine running went on
  it("goes on after a cache change when it was running, waiting for the queue or held back", async () => {
    let others = ["Sonata"];
    const r = rig({ others: () => others });
    await r.b.start(false);
    expect(r.b.state.status).toBe("blocked");
    const resume = r.b.suspend();
    expect(r.b.state.status).toBe("stopped");
    others = [];
    resume();
    // loop: NOT-WORTH — vi.waitFor polls one array for the restart [bounded: 2 s]
    await vi.waitFor(() => expect(r.sent).toHaveLength(1), { timeout: 2000 });
    // waiting for the queue: it waits again
    const q = rig();
    q.queue(true);
    await q.b.start(false);
    const again = q.b.suspend();
    again();
    // loop: NOT-WORTH — vi.waitFor polls one field for the wait [bounded: 2 s]
    await vi.waitFor(() => expect(q.b.state.status).toBe("paused"), { timeout: 2000 });
    // stopped by the user: it stays stopped
    const s = rig();
    await s.b.start(true);
    s.b.stop();
    s.b.suspend()();
    // loop: NOT-WORTH — a fixed wait is right here: nothing may restart it; one turn lets a wrong restart show
    await new Promise((res) => setTimeout(res, 0));
    expect(s.b.state.status).toBe("stopped");
    expect(s.sent).toHaveLength(1);
  });

  it("reads each built range's disk size and recorded build time, records a build, removes a size", async () => {
    const root = join(ROOT, "sizes");
    const make = (card: string, range: string) => {
      const dir = join(root, card, range);
      // loop: NOT-WORTH — five networks in a test
      for (const p of ["cradio", "moge", "rvm", "stage1", "stage2"]) {
        mkdirSync(join(dir, p), { recursive: true });
        // loop: NOT-WORTH — three files a network
        for (const [f, text] of [
          [`${p}.engine`, "x"],
          [`${p}_ctx.onnx`, "x"],
          [`${p}.source`, "s"],
        ])
          writeFileSync(join(dir, p, f), text);
      }
      return dir;
    };
    const stamps = new Map([["cradio", "s"]]);
    const hd = make("rtx-5080__drv615", "h1024-1280_w1792-2176_t1-48_f1-4");
    make("rtx-5080__drv615", "h1792-2176_w3584-4096_t1-8_f1-4");
    const bytes = async () => 2_500_000_000;
    expect(await rangesOnDisk(root, stamps, bytes)).toEqual([
      { range: "h1024-1280_w1792-2176_t1-48_f1-4", bytes: 2_500_000_000, buildSeconds: null, stale: false },
      { range: "h1792-2176_w3584-4096_t1-8_f1-4", bytes: 2_500_000_000, buildSeconds: null, stale: false },
    ]);
    await recordBuild(root, "h1024-1280_w1792-2176_t1-48_f1-4", 270.7);
    expect(JSON.parse(readFileSync(join(hd, BUILD_RECORD), "utf8")).seconds).toBe(270.7);
    expect((await rangesOnDisk(root, stamps, bytes))[0].buildSeconds).toBe(270.7);
    // the record doesn't make an unbuilt folder count as built, and the engine's networks are all it checks
    expect((await trtRangeDirs(root, stamps)).every((d) => d.built)).toBe(true);
    await removeSize(root, "h1024-1280_w1792-2176");
    expect((await trtRangeDirs(root)).map((d) => d.range)).toEqual(["h1792-2176_w3584-4096_t1-8_f1-4"]);
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

  // bug hunt 2026-10-26 U1: "A size of my own" enabled Build for a side under 16 px (it has a TensorRT range), but the
  // main process refuses that size, so the button did nothing
  it("2026-10-30: what the ticked builds cost, from this card's own builds when it has any, else the measured cost", () => {
    expect(buildTotals(3, [])).toEqual({ bytes: 3 * 2.8e9, minutes: [expect.closeTo(13.2, 6), expect.closeTo(14.4, 6)], here: false });
    const own = [
      { bytes: 2.6e9, buildSeconds: 300, stale: false },
      { bytes: 2.6e9, buildSeconds: null, stale: false },
      { bytes: 9e9, buildSeconds: 9000, stale: true },
    ];
    expect(buildTotals(2, own)).toEqual({ bytes: 5.2e9, minutes: [10, 10], here: true });
    expect(buildTotals(0, own).bytes).toBe(0);
  });

  it("offers Build for a size of one's own only when the main process takes it", () => {
    // the mismatch the button had: a range, but a size the main process refuses
    expect(trtSizeKey(10, 1080)).not.toBeNull();
    expect(sanitizeTrtSize({ label: "Your size", width: 10, height: 1080 })).toBeNull();
    expect(ownTrtSize(10, 1080)).toBeNull();
    expect(ownTrtSize(1920, 0)).toBeNull();
    expect(ownTrtSize(6144, 3240)).toBeNull();
    expect(ownTrtSize(2560, 1440)).toEqual({ size: { label: "Your size", width: 2560, height: 1440 }, key: "h1408-1664_w2304-2816" });
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
