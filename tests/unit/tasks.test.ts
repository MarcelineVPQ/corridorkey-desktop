import { describe, expect, it } from "vitest";
import { dots, jobToSelect, missingInput, startBlocked, tasksOf } from "../../src/shared/tasks";
import { DEFAULT_OPTIONS, type InstallStatus } from "../../src/shared/types";
import { appState as state, clipInfo, ffmpegState, installState, job, trtState } from "./fixtures";

// the runtime and models missing (2 + 3 bytes), the install idle, running or stopped with an error
const installing = (status: InstallStatus, error: string | null = null) => installState({ needRuntime: true, needModels: true, bytes: 5, runtimeBytes: 2, modelsBytes: 3, status, error });

describe("TensorRT task", () => {
  // switched on, its libraries and models still to download
  const trt = (extra: Parameters<typeof trtState>[0]) => trtState({ on: true, needLibs: true, needModels: true, bytes: 1, fullBytes: 1, ...extra });
  it("asks for TensorRT's parts once it is switched on (on top of the runtime and models), never while off", () => {
    expect(tasksOf(state({ tensorrt: trt({}) }))).toEqual([expect.objectContaining({ id: "tensorrt", page: "engine", section: "tensorrt", level: "task" })]);
    expect(tasksOf(state({ tensorrt: trt({ on: false }) }))).toEqual([]);
    expect(tasksOf(state({ tensorrt: trt({ status: "running" }) }))).toEqual([]);
    expect(tasksOf(state({ tensorrt: trt({ needLibs: false, needModels: false, ready: true }) }))).toEqual([]);
    expect(tasksOf(state({ tensorrt: trt({ status: "error", error: "no space" }) }))[0]).toMatchObject({ level: "error", text: "The TensorRT download stopped: no space" });
    // the runtime and models come first: their task, not TensorRT's
    expect(tasksOf(state({ engineKind: null, install: installing("idle"), tensorrt: trt({}) })).map((t) => t.id)).toEqual(["install"]);
  });
});

describe("first-run install and ffmpeg tasks", () => {
  it("asks for the install; while it runs there is no task (not the engine-setup one either)", () => {
    expect(tasksOf(state({ engineKind: null, install: installing("idle") }))).toEqual([expect.objectContaining({ id: "install", section: "install" })]);
    expect(tasksOf(state({ engineKind: null, install: installing("running") }))).toEqual([]);
    expect(tasksOf(state({ engineKind: null, install: installing("error", "no space") }))[0]).toMatchObject({ level: "error", text: "The install stopped: no space" });
  });
  it("says nothing about ffmpeg before the first check has answered", () => {
    expect(tasksOf(state({ ffmpeg: ffmpegState({ checked: false, ok: false }) }))).toEqual([]);
    expect(tasksOf(state({ ffmpeg: ffmpegState({ ok: false, problem: "ffmpeg isn't installed (ffprobe not found)" }) }))[0]).toMatchObject({ id: "ffmpeg" });
  });
});

describe("tasks (the one mechanism)", () => {
  it("a hint mode without its file is a task on the clip's Hint section", () => {
    const j = job("a", { options: { ...DEFAULT_OPTIONS, hintMode: "first-frame", hintFirstFrame: null } });
    expect(missingInput(j)).toMatch(/first-frame matte/);
    const t = tasksOf(state({ jobs: [j] }));
    expect(t).toEqual([expect.objectContaining({ page: "queue", section: "hint", jobId: "a" })]);
    expect(dots(t).targets.queue).toBe("hint");
  });
  it("no engine set up points at Engine → ONNX engine; it clears when either engine is set up", () => {
    const t = tasksOf(state({ checkout: { ok: false, problems: ["Choose your CorridorKey2.0 folder."] }, engineKind: null }));
    expect(t[0]).toMatchObject({ page: "engine", section: "onnx", text: "Choose the CorridorKey engine program (corridorkey-engine)." });
    expect(tasksOf(state({}))).toEqual([]);
    expect(tasksOf(state({ engineKind: "rust", checkout: { ok: false, problems: ["x"] } }))).toEqual([]);
  });
  it("failed clips are one error on the Queue item, every text on its own line", () => {
    const t = tasksOf(state({ jobs: [job("a", { status: "failed" }), job("b", { status: "failed" })], engine: { status: "failed", pong: null, error: "no python" } }));
    const d = dots(t);
    expect(d.pages.queue).toBe("2 clips failed");
    expect(d.pages.engine).toMatch(/no python/);
  });
  it("a clip the app can't read is an error on the Queue item that selects that clip", () => {
    const bad = job("b", { clip: clipInfo("b", { probeError: "ffprobe: Invalid data found when processing input" }) });
    const t = tasksOf(state({ jobs: [job("a"), bad] }));
    expect(t).toEqual([expect.objectContaining({ page: "queue", level: "error", jobId: "b" })]);
    expect(jobToSelect(t, "queue")).toBe("b");
    expect(jobToSelect(t, "engine")).toBe(null);
    expect(dots(t).pages.queue).toBe("b: Can't read this clip (ffprobe: Invalid data found when processing input)");
    // it clears when the clip is removed
    expect(tasksOf(state({ jobs: [job("a")] }))).toEqual([]);
  });
});

describe("Start queue", () => {
  const ready = job("j1");
  it("is disabled with the reason while the cache folder moves; enabled once it is done", () => {
    const cache = { dir: "/c", defaultDir: "/c", isDefault: true, bytes: 0, shots: [], otherBytes: 0, trtRanges: [], moving: "Moving 1 GB to /media/m/disk/corridorkey-desktop…", error: null };
    expect(startBlocked(state({ jobs: [ready], cache }))).toBe("Moving the cache folder… the queue can start when it's done");
    expect(startBlocked(state({ jobs: [ready], cache: { ...cache, moving: null } }))).toBeNull();
    expect(startBlocked(state({ jobs: [] }))).toBe("Add a clip that's ready to run");
  });
});

describe("cache folder drive", () => {
  it("a chosen cache folder's drive not there is a task on Storage", () => {
    expect(tasksOf(state({ cacheMissing: "/media/m/disk isn't there: is its drive connected?" }))).toEqual([
      expect.objectContaining({ id: "cache-missing", page: "settings", section: "storage", level: "task" }),
    ]);
  });
});
