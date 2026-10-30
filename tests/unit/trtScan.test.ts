import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanClipSizes } from "../../electron/main/trtScan";
import { SCAN_MAX_CLIPS } from "../../src/shared/trt";

const ROOT = mkdtempSync(join(tmpdir(), "ck-scan-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const file = (...p: string[]) => {
  mkdirSync(join(ROOT, ...p.slice(0, -1)), { recursive: true });
  writeFileSync(join(ROOT, ...p), "");
};

describe("the TensorRT checklist's folder scan (Marcy 2026-10-30)", () => {
  it("reads each clip's size in the folder and two levels under it, counts per size, skips hidden and deeper folders", async () => {
    const root = join(ROOT, "a");
    file("a", "plate.mp4");
    file("a", "plate_AlphaHint.mp4");
    file("a", "shot_010", "Input", "0001.exr");
    file("a", "day1", "cam_b", "take2.mov");
    file("a", "day1", "cam_b", "deep", "never.mp4");
    file("a", ".cache", "hidden.mp4");
    file("a", "broken.mov");
    const probed: string[] = [];
    const r = await scanClipSizes(root, {
      probe: (path) => {
        probed.push(path.slice(root.length + 1));
        if (path.endsWith("broken.mov")) return Promise.reject(new Error("moov atom not found"));
        return Promise.resolve(path.endsWith("Input") ? { width: 4096, height: 2160 } : { width: 1920, height: 1080 });
      },
    });
    expect(probed.sort()).toEqual(["broken.mov", "day1/cam_b/take2.mov", "plate.mp4", "shot_010/Input"]);
    expect(r).toEqual({
      clips: 3,
      found: expect.arrayContaining([
        { width: 1920, height: 1080, clips: 2 },
        { width: 4096, height: 2160, clips: 1 },
      ]),
      unreadable: 1,
      capped: false,
    });
  });

  it(`stops at ${SCAN_MAX_CLIPS} clips, and at once when stopped`, async () => {
    const root = join(ROOT, "many");
    // loop: NOT-WORTH — a test's empty files
    for (let i = 0; i <= SCAN_MAX_CLIPS; i++) file("many", `c${i}.mp4`);
    const probe = () => Promise.resolve({ width: 1920, height: 1080 });
    expect(await scanClipSizes(root, { probe })).toMatchObject({ clips: SCAN_MAX_CLIPS, capped: true });
    const stop = new AbortController();
    const r = await scanClipSizes(root, {
      probe,
      signal: stop.signal,
      progress: (p) => {
        if (p.clips === 3) stop.abort();
      },
    });
    expect(r).toMatchObject({ clips: 3, capped: false });
  });
});
