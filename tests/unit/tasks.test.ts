import { describe, expect, it } from "vitest";
import { dots, missingInput, tasksOf } from "../../src/shared/tasks";
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
    desktopPalette: null,
    ...extra,
  }) as AppState;

describe("tasks (the one mechanism)", () => {
  it("a hint mode without its file is a task on the clip's Hint section", () => {
    const j = job("a", { options: { ...DEFAULT_OPTIONS, hintMode: "first-frame", hintFirstFrame: null } });
    expect(missingInput(j)).toMatch(/first-frame matte/);
    const t = tasksOf(state({ jobs: [j] }));
    expect(t).toEqual([expect.objectContaining({ page: "queue", section: "hint", jobId: "a" })]);
    expect(dots(t).targets.queue).toBe("hint");
  });
  it("a missing checkout points at Engine → CorridorKey folder; it clears when fixed", () => {
    const t = tasksOf(state({ checkout: { ok: false, problems: ["Choose your CorridorKey2.0 folder."] } }));
    expect(t[0]).toMatchObject({ page: "engine", section: "folder" });
    expect(tasksOf(state({}))).toEqual([]);
  });
  it("failed clips are one error on the Queue item, every text on its own line", () => {
    const t = tasksOf(state({ jobs: [job("a", { status: "failed" }), job("b", { status: "failed" })], engine: { status: "failed", pong: null, error: "no python" } }));
    const d = dots(t);
    expect(d.pages.queue).toBe("2 clips failed");
    expect(d.pages.engine).toMatch(/no python/);
  });
});
