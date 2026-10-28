import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadSettings } from "../../electron/main/settings";
import { fromAppPageOnly, idArg, pathArg, pathsArg, sanitizeAppearance, sanitizeOptions, uniqueOutputDir, vramLimit } from "../../electron/main/validate";
import { DEFAULT_APPEARANCE, DEFAULT_OPTIONS, FRAME_DIR_FPS_RANGE, frameRateOf, MANUAL_WINDOWS, scaledSize, vramLimitChoices, windowChoices } from "../../src/shared/types";

describe("IPC and settings validation", () => {
  it("keeps valid job options as they are", () => {
    const o = { ...DEFAULT_OPTIONS, outputs: ["alpha", "cutout"], memory: { auto: false, hannChunk: 24, hannStride: 12, lowVram: true }, hintMode: "video", hintVideo: "/h.mp4" };
    expect(sanitizeOptions(o)).toEqual(o);
  });

  it("replaces what the engine would refuse or the app can't use", () => {
    const o = sanitizeOptions({
      outputs: ["alpha", "matte"],
      memory: { auto: false, hannChunk: 2, hannStride: 4 },
      despillStrength: "0.5",
      hintQuality: 7,
      outputFormat: "gif",
      frameDirFps: -1,
      hintMode: "magic",
    });
    expect(o.outputs).toEqual(["alpha"]);
    expect(o.memory).toEqual({ auto: true });
    expect([o.despillStrength, o.hintQuality, o.outputFormat, o.frameDirFps, o.hintMode]).toEqual([0.5, 0.95, "video", 24, "none"]);
    expect(sanitizeOptions(null)).toEqual(DEFAULT_OPTIONS);
    expect(sanitizeOptions({ outputs: [] }).outputs).toEqual(["alpha", "fg"]);
  });

  it("keeps the offered internal resolutions and the linear adjust within its ranges", () => {
    const o = sanitizeOptions({ modelScale: 0.25, linearBrightness: 2, linearContrast: 0.5, linearContrastPivot: 0.3 });
    expect([o.modelScale, o.linearBrightness, o.linearContrast, o.linearContrastPivot]).toEqual([0.25, 2, 0.5, 0.3]);
    const bad = sanitizeOptions({ modelScale: 0.6, linearBrightness: 0, linearContrast: 9, linearContrastPivot: "x" });
    expect([bad.modelScale, bad.linearBrightness, bad.linearContrast, bad.linearContrastPivot]).toEqual([1, 1, 1, 0.18]);
    expect([sanitizeOptions({}).deepInput, sanitizeOptions({ deepInput: true }).deepInput, sanitizeOptions({ deepInput: "yes" }).deepInput]).toEqual([false, true, false]);
  });

  it("whole review S10: the frame-rate field takes what sanitizeOptions keeps, and never snaps while typing", () => {
    const [lo, hi] = FRAME_DIR_FPS_RANGE;
    expect([sanitizeOptions({ frameDirFps: lo }).frameDirFps, sanitizeOptions({ frameDirFps: hi }).frameDirFps]).toEqual([lo, hi]);
    expect([sanitizeOptions({ frameDirFps: lo / 2 }).frameDirFps, sanitizeOptions({ frameDirFps: hi + 1 }).frameDirFps]).toEqual([24, 24]);
    expect([frameRateOf(String(lo)), frameRateOf(String(hi)), frameRateOf("23.976"), frameRateOf("2")]).toEqual([lo, hi, 23.976, 2]);
    // empty, half-typed or out of range: the field keeps the text, the setting stays (no 24 while typing)
    expect([frameRateOf(""), frameRateOf("0"), frameRateOf("-"), frameRateOf(String(hi + 1))]).toEqual([null, null, null, null]);
  });

  it("whole review: the Manual picker shows a kept window that isn't one of its choices", () => {
    const kept = sanitizeOptions({ memory: { auto: false, hannChunk: 32, hannStride: 16 } }).memory;
    expect(kept).toMatchObject({ hannChunk: 32, hannStride: 16 });
    expect(windowChoices(32, 16)).toEqual([...MANUAL_WINDOWS, [32, 16]]);
    expect(windowChoices(24, 12)).toEqual([...MANUAL_WINDOWS]);
  });

  it("sizes the internal resolution as the engine does (Python round, half to even)", () => {
    expect([scaledSize(1080, 0.75), scaledSize(1081, 0.5), scaledSize(1919, 0.5), scaledSize(5, 0.5), scaledSize(7, 0.5), scaledSize(3, 0.25)]).toEqual([810, 540, 960, 2, 4, 1]);
  });

  it("video codec: the platform's offer, default lossless H.264; a video cutout brings the Alpha output", () => {
    expect(sanitizeOptions({ videoCodec: "dnxhr444" }, "linux").videoCodec).toBe("dnxhr444");
    expect(sanitizeOptions({ videoCodec: "h264-crf12" }, "win32").videoCodec).toBe("h264-crf12");
    // the Mac: lossless H.264 until ProRes 4444 XQ comes with the Mac work
    expect(sanitizeOptions({ videoCodec: "dnxhr444" }, "darwin").videoCodec).toBe("h264-lossless");
    expect(sanitizeOptions({ videoCodec: "prores" }, "linux").videoCodec).toBe("h264-lossless");
    expect(sanitizeOptions({}).videoCodec).toBe("h264-lossless");
    expect(sanitizeOptions({ outputs: ["cutout"] }).outputs).toEqual(["alpha", "cutout"]);
    expect(sanitizeOptions({ outputs: ["cutout"], outputFormat: "exr" }).outputs).toEqual(["cutout"]);
  });

  it("appearance: only known themes and accents", () => {
    expect(sanitizeAppearance({ theme: "solarized", accent: "desktop", glass: "yes" })).toEqual({ ...DEFAULT_APPEARANCE, accent: "desktop" });
  });

  it("ids, paths and dropped paths", () => {
    expect([idArg("a1"), idArg(3), idArg("")]).toEqual(["a1", null, null]);
    expect([pathArg("/o/x.mp4"), pathArg("x.mp4"), pathArg({})]).toEqual(["/o/x.mp4", null, null]);
    expect(pathsArg(["/a", 4, null, "/b"])).toEqual(["/a", "/b"]);
    expect(pathsArg("/a")).toEqual([]);
    // review 2026-10-28 #6: relative paths and flags never reach ffprobe or the engine
    expect(pathsArg(["/a", "b.mov", "-i", "--help", "../x.mov", ""])).toEqual(["/a"]);
    const o = sanitizeOptions({ hintMode: "video", hintFirstFrame: "hint.png", hintVideo: "-filter_complex" });
    expect([o.hintFirstFrame, o.hintVideo]).toEqual([null, null]);
    const ok = sanitizeOptions({ hintMode: "video", hintFirstFrame: "/h/hint.png", hintVideo: "/h/hint.mov" });
    expect([ok.hintFirstFrame, ok.hintVideo]).toEqual(["/h/hint.png", "/h/hint.mov"]);
  });

  it("a settings file from an older or hand-edited version loads as valid settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-settings-"));
    try {
      const file = join(dir, "settings.json");
      writeFileSync(file, JSON.stringify({ lastOptions: { outputs: ["matte"], memory: { auto: false, hannChunk: 24 } }, appearance: { theme: "neon" }, outputRoot: 5 }));
      const s = loadSettings(file);
      expect(s.lastOptions.outputs).toEqual(["alpha", "fg"]);
      expect(s.lastOptions.memory).toEqual({ auto: true });
      expect(s.appearance).toEqual(DEFAULT_APPEARANCE);
      expect(s.outputRoot).toBeNull();
      // review N4: no frame-folder choice is remembered for later folders (each starts by its format), so a file
      // from dev.1's draft that saved one doesn't bring it back
      writeFileSync(file, JSON.stringify({ frameDirLinear: false }));
      expect(loadSettings(file)).not.toHaveProperty("frameDirLinear");
      writeFileSync(file, "[1, 2"); // cut short
      expect(loadSettings(file).lastOptions).toEqual(DEFAULT_OPTIONS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the graphics memory limit: whole GiB within the menus' range, else Auto (backlog rows 43, 44)", () => {
    expect([vramLimit(12), vramLimit(2), vramLimit(256)]).toEqual([12, 2, 256]);
    expect([vramLimit(1), vramLimit(257), vramLimit(7.5), vramLimit("12"), vramLimit(null), vramLimit(NaN)]).toEqual([null, null, null, null, null, null]);
    expect(sanitizeOptions({ vramLimitGb: 8 }).vramLimitGb).toBe(8);
    expect(sanitizeOptions({ vramLimitGb: -3 }).vramLimitGb).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "ck-settings-"));
    try {
      const file = join(dir, "settings.json");
      writeFileSync(file, JSON.stringify({ vramLimitGb: 10, cacheRoot: "/media/fast" }));
      expect(loadSettings(file)).toMatchObject({ vramLimitGb: 10, cacheRoot: "/media/fast" });
      // a relative cache location or a bad limit: the defaults (the system's cache folder, Auto)
      writeFileSync(file, JSON.stringify({ vramLimitGb: "lots", cacheRoot: "fast" }));
      expect(loadSettings(file)).toMatchObject({ vramLimitGb: null, cacheRoot: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the limit menu runs up to the card's size once read, and keeps the current choice", () => {
    expect(vramLimitChoices(16 * 1073741824, null)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    // a card that reports 15.9 GiB: up to 15
    expect(vramLimitChoices(15.9 * 1073741824, null).at(-1)).toBe(15);
    // a default set on a bigger card stays offered
    expect(vramLimitChoices(8 * 1073741824, 24)).toEqual([2, 3, 4, 5, 6, 7, 8, 24]);
    // the card's size not read yet: a fixed set
    expect(vramLimitChoices(null, null)).toEqual([2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 32, 48]);
  });

  it("two clips with the same name never share an output folder", () => {
    const jobs = [{ outputDir: "/c/out_shot", clip: { path: "/c/shot.mp4" } }] as Parameters<typeof uniqueOutputDir>[2];
    expect(uniqueOutputDir("/c/out_shot", "/c/shot.mov", jobs)).toBe("/c/out_shot-2");
    expect(uniqueOutputDir("/c/out_shot", "/c/shot.mp4", jobs)).toBe("/c/out_shot"); // the same clip again
    const more = [...jobs, { outputDir: "/c/out_shot-2", clip: { path: "/d/shot.mp4" } }] as typeof jobs;
    expect(uniqueOutputDir("/c/out_shot", "/e/shot.mp4", more)).toBe("/c/out_shot-3");
  });

  it("folder names differing only in case are one folder on Windows and macOS, two on Linux (review 2026-10-27)", () => {
    const jobs = [{ outputDir: "/c/out_Plate", clip: { path: "/c/Plate.mov" } }] as Parameters<typeof uniqueOutputDir>[2];
    expect(uniqueOutputDir("/c/out_plate", "/c/plate.mp4", jobs, "win32")).toBe("/c/out_plate-2");
    expect(uniqueOutputDir("/c/out_plate", "/c/plate.mp4", jobs, "darwin")).toBe("/c/out_plate-2");
    expect(uniqueOutputDir("/c/out_plate", "/c/plate.mp4", jobs, "linux")).toBe("/c/out_plate");
    // the same clip again (case aside) keeps its folder
    expect(uniqueOutputDir("/c/out_Plate", "/c/PLATE.mov", jobs, "win32")).toBe("/c/out_Plate");
  });

  it("runs an IPC handler only for the app page's top frame (fromAppPageOnly)", () => {
    const mainFrame = { url: "file:///opt/CorridorKey/resources/app.asar/out/renderer/index.html#/queue" };
    const wc = { mainFrame };
    let contents: typeof wc | null = wc;
    const fn = vi.fn((_e: unknown, a: unknown, b: unknown) => [a, b]);
    const h = fromAppPageOnly(() => contents && { contents, url: "file:///opt/CorridorKey/resources/app.asar/out/renderer/index.html" }, fn);
    expect(h({ sender: wc, senderFrame: mainFrame }, 1, 2)).toEqual([1, 2]);
    // the top frame showing another page (review 2026-10-27)
    mainFrame.url = "https://example.com/index.html";
    expect(h({ sender: wc, senderFrame: mainFrame }, 1, 2)).toBeUndefined();
    mainFrame.url = "file:///tmp/index.html";
    expect(h({ sender: wc, senderFrame: mainFrame }, 1, 2)).toBeUndefined();
    mainFrame.url = "file:///opt/CorridorKey/resources/app.asar/out/renderer/index.html";
    expect(h({ sender: wc, senderFrame: {} }, 1, 2)).toBeUndefined(); // an embedded frame
    expect(h({ sender: {}, senderFrame: mainFrame }, 1, 2)).toBeUndefined(); // another window
    expect(h({ sender: wc, senderFrame: null }, 1, 2)).toBeUndefined();
    contents = null; // the window is gone
    expect(h({ sender: wc, senderFrame: mainFrame }, 1, 2)).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
