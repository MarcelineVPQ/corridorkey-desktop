import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { clipName, expandPaths, findFirstFrameHint, findHintVideo, frameDirLinearFor, frameFiles, isCompanionHint, naturalCompare, still } from "../../electron/main/media";

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
  it("prefers <clip>FrameHint over the older _alphahint image", async () => {
    const d = dir(["shot01.mov", "shot01_alphahint.png", "shot01FrameHint.png"]);
    expect(await findFirstFrameHint(join(d, "shot01.mov"))).toBe(join(d, "shot01FrameHint.png"));
  });
  it("finds <clip>_AlphaHint.mp4 as the hint video, case-insensitively", async () => {
    const d = dir(["shot01.mov", "SHOT01_AlphaHint.mp4"]);
    expect(await findHintVideo(join(d, "shot01.mov"), "video")).toBe(join(d, "SHOT01_AlphaHint.mp4"));
  });
  it("a <shot>/Input folder takes <shot>/AlphaHint", async () => {
    const d = dir(["shotA/Input/f_0001.png", "shotA/AlphaHint/f_0001.png"]);
    expect(await findHintVideo(join(d, "shotA", "Input"), "frames")).toBe(join(d, "shotA", "AlphaHint"));
    expect(clipName(join(d, "shotA", "Input"))).toBe("shotA");
  });
});

describe("expandPaths", () => {
  it("expands a batch folder to its clips and skips hint videos", async () => {
    const d = dir(["a.mp4", "a_AlphaHint.mp4", "b.mov", "notes.txt"]);
    expect((await expandPaths([d])).map((c) => c.path)).toEqual([join(d, "a.mp4"), join(d, "b.mov")]);
    expect(isCompanionHint(join(d, "a_AlphaHint.mp4"))).toBe(true);
  });
  it("a folder of frames is one clip", async () => {
    const d = dir(["f_0001.exr", "f_0002.exr"]);
    expect(await expandPaths([d])).toEqual([{ path: d, kind: "frames" }]);
  });
  it("reads without blocking the main process; a path that is gone is skipped, one that can't be read is named (review 2026-10-27)", async () => {
    const d = dir(["a.mp4"]);
    const pending = expandPaths([join(d, "gone.mp4"), d]);
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toEqual([{ path: join(d, "a.mp4"), kind: "video" }]);
    // a file where a folder is expected in the path: not "gone", unreadable (ENOTDIR; Windows says ENOENT)
    if (process.platform !== "win32") await expect(expandPaths([join(d, "a.mp4", "x")])).rejects.toThrow(`${join(d, "a.mp4", "x")}: `);
  });
});

describe("frame order (CorridorKey2.0 PR #4: natural order, any extension case)", () => {
  it("sorts like the engine: f_2 before f_10, padding by value", () => {
    expect(["f_10.PNG", "f_1.png", "f_002b.exr", "f_2.Png"].sort(naturalCompare)).toEqual(["f_1.png", "f_2.Png", "f_002b.exr", "f_10.PNG"]);
    expect(naturalCompare("frame_0009", "frame_0010")).toBeLessThan(0);
    expect(naturalCompare("a9", "a09")).toBeGreaterThan(0);
  });
  it("finds .EXR / .Png frames and leaves other files out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-frames-"));
    // loop: NOT-WORTH — a test's few files
    for (const n of ["f_1.png", "f_10.PNG", "f_2.Png", "notes.txt"]) writeFileSync(join(dir, n), "");
    expect((await frameFiles(dir)).map((p) => basename(p))).toEqual(["f_1.png", "f_2.Png", "f_10.PNG"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

// Marcy 2026-10-27: an EXR plate folder (scene-linear by convention, e.g. Tears of Steel's F65 plates) started as
// "display-coded", clipping everything above 1, unless the user noticed the box
describe("a frame folder's scene-linear default", () => {
  it("is on for EXR frames and off for the others", async () => {
    const exr = dir(["f.0002.exr", "f.0001.EXR"]);
    const png = dir(["f.0001.png", "f.0002.png"]);
    const jpg = dir(["f.0001.jpg"]);
    expect(await frameDirLinearFor(exr)).toBe(true);
    expect(await frameDirLinearFor(png)).toBe(false);
    expect(await frameDirLinearFor(jpg)).toBe(false);
  });
});

// Marcy 2026-10-27: the Results stills showed faint green lines in black areas. The engine's video is yuv444p10le,
// TV range; straight to JPEG, ffmpeg's yuvj420p conversion rounded near-black chroma to green (G=1, whole block rows)
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
describe("a still of the engine's video", () => {
  it.skipIf(!hasFfmpeg)("keeps black exactly black", async () => {
    const d = dir([]);
    const clip = join(d, "black_alpha.mp4");
    // black, encoded as the engine's lossless H.264 is (ck-core writers.rs ffmpeg_args: bgr48le in, yuv444p10le, -qp 0)
    const raw = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=1920x1080:r=24:d=0.125", "-f", "rawvideo", "-pix_fmt", "bgr48le", "-"], { maxBuffer: 1 << 26 });
    // prettier-ignore
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr48le", "-s:v", "1920x1080", "-r", "24", "-i", "pipe:0", "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high444", "-pix_fmt", "yuv444p10le", "-qp", "0",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "iec61966-2-1", clip], { input: raw });
    const file = await still(join(d, "cache"), clip, 0, 640);
    const pixels = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 24 });
    expect(pixels.length).toBe(640 * 360 * 3);
    expect(pixels.some((v) => v !== 0)).toBe(false);
  });

  // Marcy 2026-10-28: the foreground still was black where the subject isn't; a compositor shows a key over a checker
  it.skipIf(!hasFfmpeg)("shows the foreground over the checker where its alpha is 0, never black", async () => {
    const d = dir([]);
    const make = (name: string, color: string) => {
      const f = join(d, name);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=${color}:s=1280x720:r=24:d=0.125`, "-c:v", "libx264", "-pix_fmt", "yuv444p", "-qp", "0", f]);
      return f;
    };
    const fg = make("shot_fg.mp4", "black");
    const alpha = make("shot_alpha.mp4", "black");
    const file = await still(join(d, "cache"), fg, 0, 640, { alpha, premultiplied: false, square: 32 });
    const pixels = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 24 });
    const at = (x: number, y: number) => pixels[(y * 640 + x) * 3];
    // the first square light (191), the next one dark (128), within JPEG rounding
    expect(Math.abs(at(8, 8) - 191)).toBeLessThan(8);
    expect(Math.abs(at(40, 8) - 128)).toBeLessThan(8);
  });
});
