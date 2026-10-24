import { describe, expect, it } from "vitest";
import { dots, jobToSelect, missingInput, tasksOf } from "../../src/shared/tasks";
import { DEFAULT_APPEARANCE, DEFAULT_OPTIONS, type AppState, type Job } from "../../src/shared/types";

const job = (id: string, extra: Partial<Job> = {}): Job =>
  ({
    id,
    clip: { path: `/c/${id}.mp4`, name: id, kind: "video", width: 1, height: 1, fps: 24, frames: 1, thumb: null, companionFirstFrame: null, companionHintVideo: null, probeError: null },
    options: { ...DEFAULT_OPTIONS },
    status: "waiting",
    ...extra,
  }) as Job;

const state = (extra: Partial<AppState>): AppState =>
  ({
    version: "0.1.0-dev.1",
    jobs: [],
    queueRunning: false,
    engine: { status: "stopped", pong: null, error: null },
    gpu: null,
    gpuError: null,
    settings: { corridorKeyRoot: "/ck", lastOptions: DEFAULT_OPTIONS, appearance: DEFAULT_APPEARANCE, outputRoot: null },
    checkout: { ok: true, problems: [] },
    rustEngine: { ok: false, problems: ["Choose the CorridorKey engine program (corridorkey-engine)."] },
    engineKind: "python",
    desktopPalette: null,
    install: { dir: "/d", needRuntime: false, needModels: false, bytes: 0, runtimeBytes: 0, modelsBytes: 0, nvidia: true, status: "idle", step: null, done: 0, total: 0, error: null },
    ffmpeg: { checked: true, ok: true, problem: null, command: "", canInstall: false, asksPassword: true, note: null, installing: false, installError: null },
    ...extra,
  }) as AppState;

const installing = (status: "idle" | "running" | "error", error: string | null = null) => ({
  dir: "/d",
  needRuntime: true,
  needModels: true,
  bytes: 5,
  runtimeBytes: 2,
  modelsBytes: 3,
  nvidia: true,
  status,
  step: null,
  done: 0,
  total: 0,
  error,
});

describe("first-run install and ffmpeg tasks", () => {
  it("asks for the install; while it runs there is no task (not the engine-setup one either)", () => {
    expect(tasksOf(state({ engineKind: null, install: installing("idle") }))).toEqual([expect.objectContaining({ id: "install", section: "install" })]);
    expect(tasksOf(state({ engineKind: null, install: installing("running") }))).toEqual([]);
    expect(tasksOf(state({ engineKind: null, install: installing("error", "no space") }))[0]).toMatchObject({ level: "error", text: "The install stopped: no space" });
  });
  it("says nothing about ffmpeg before the first check has answered", () => {
    const ff = { checked: false, ok: false, problem: null, command: "", canInstall: false, asksPassword: true, note: null, installing: false, installError: null };
    expect(tasksOf(state({ ffmpeg: ff }))).toEqual([]);
    expect(tasksOf(state({ ffmpeg: { ...ff, checked: true, problem: "ffmpeg isn't installed (ffprobe not found)" } }))[0]).toMatchObject({ id: "ffmpeg" });
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
    const bad = job("b", { clip: { ...job("b").clip, probeError: "ffprobe: Invalid data found when processing input" } });
    const t = tasksOf(state({ jobs: [job("a"), bad] }));
    expect(t).toEqual([expect.objectContaining({ page: "queue", level: "error", jobId: "b" })]);
    expect(jobToSelect(t, "queue")).toBe("b");
    expect(jobToSelect(t, "engine")).toBe(null);
    expect(dots(t).pages.queue).toBe("b: Can't read this clip (ffprobe: Invalid data found when processing input)");
    // it clears when the clip is removed
    expect(tasksOf(state({ jobs: [job("a")] }))).toEqual([]);
  });
});
