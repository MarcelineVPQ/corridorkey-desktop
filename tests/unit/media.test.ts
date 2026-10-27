import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { clipName, expandPaths, findFirstFrameHint, findHintVideo, frameDirLinearFor, frameFiles, isCompanionHint, naturalCompare } from "../../electron/main/media";

// every folder a test made goes at the end (each run used to leave five in /tmp, which is RAM on many desktops)
const made: string[] = [];
// loop: NOT-WORTH — the test folders, once after the file's tests
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function dir(files: string[]): string {
  const d = mkdtempSync(join(tmpdir(), "ck-media-"));
  made.push(d);
  for (const f of files) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), "");
  }
  return d;
}

describe("companion hints (run_interactive.py naming)", () => {
  it("prefers <clip>FrameHint over the older _alphahint image", () => {
    const d = dir(["shot01.mov", "shot01_alphahint.png", "shot01FrameHint.png"]);
    expect(findFirstFrameHint(join(d, "shot01.mov"))).toBe(join(d, "shot01FrameHint.png"));
  });
  it("finds <clip>_AlphaHint.mp4 as the hint video, case-insensitively", () => {
    const d = dir(["shot01.mov", "SHOT01_AlphaHint.mp4"]);
    expect(findHintVideo(join(d, "shot01.mov"), "video")).toBe(join(d, "SHOT01_AlphaHint.mp4"));
  });
  it("a <shot>/Input folder takes <shot>/AlphaHint", () => {
    const d = dir(["shotA/Input/f_0001.png", "shotA/AlphaHint/f_0001.png"]);
    expect(findHintVideo(join(d, "shotA", "Input"), "frames")).toBe(join(d, "shotA", "AlphaHint"));
    expect(clipName(join(d, "shotA", "Input"))).toBe("shotA");
  });
});

describe("expandPaths", () => {
  it("expands a batch folder to its clips and skips hint videos", () => {
    const d = dir(["a.mp4", "a_AlphaHint.mp4", "b.mov", "notes.txt"]);
    expect(expandPaths([d]).map((c) => c.path)).toEqual([join(d, "a.mp4"), join(d, "b.mov")]);
    expect(isCompanionHint(join(d, "a_AlphaHint.mp4"))).toBe(true);
  });
  it("a folder of frames is one clip", () => {
    const d = dir(["f_0001.exr", "f_0002.exr"]);
    expect(expandPaths([d])).toEqual([{ path: d, kind: "frames" }]);
  });
});

describe("frame order (CorridorKey2.0 PR #4: natural order, any extension case)", () => {
  it("sorts like the engine: f_2 before f_10, padding by value", () => {
    expect(["f_10.PNG", "f_1.png", "f_002b.exr", "f_2.Png"].sort(naturalCompare)).toEqual(["f_1.png", "f_2.Png", "f_002b.exr", "f_10.PNG"]);
    expect(naturalCompare("frame_0009", "frame_0010")).toBeLessThan(0);
    expect(naturalCompare("a9", "a09")).toBeGreaterThan(0);
  });
  it("finds .EXR / .Png frames and leaves other files out", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-frames-"));
    // loop: NOT-WORTH — a test's few files
    for (const n of ["f_1.png", "f_10.PNG", "f_2.Png", "notes.txt"]) writeFileSync(join(dir, n), "");
    expect(frameFiles(dir).map((p) => basename(p))).toEqual(["f_1.png", "f_2.Png", "f_10.PNG"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

// Marcy 2026-10-27: an EXR plate folder (scene-linear by convention, e.g. Tears of Steel's F65 plates) started as
// "display-coded", clipping everything above 1, unless the user noticed the box
describe("a frame folder's scene-linear default", () => {
  it("is on for EXR frames and off for the others, unless the user chose", () => {
    const exr = dir(["f.0002.exr", "f.0001.EXR"]);
    const png = dir(["f.0001.png", "f.0002.png"]);
    const jpg = dir(["f.0001.jpg"]);
    expect(frameDirLinearFor(exr, null)).toBe(true);
    expect(frameDirLinearFor(png, null)).toBe(false);
    expect(frameDirLinearFor(jpg, null)).toBe(false);
    // the user's own choice wins either way
    expect(frameDirLinearFor(exr, false)).toBe(false);
    expect(frameDirLinearFor(png, true)).toBe(true);
  });
});
