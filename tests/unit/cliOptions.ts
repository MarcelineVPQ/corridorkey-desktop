// What the corridorkey CLI hands the engine for a line, worked out from the Console's own parser and the CLI's own
// table (ck-cli args.rs RUN_OPTIONS, read from the source), and the engine's defaults for what a line leaves out:
// the round trips of Copy as command (jobCommand.test.ts) and farm export (farmExport.test.ts) compare it with the
// app's own request (queue.ts engineOptions).
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { parse, quoteArg } from "../../src/shared/console/parse";
import { makeRegistry } from "../../src/shared/console/registry";
import type { JobOptions } from "../../src/shared/types";

const reg = makeRegistry();
const args = readFileSync(new URL("../../engine-rs/crates/ck-cli/src/args.rs", import.meta.url), "utf8");
/** flag → [run option, kind], as the CLI maps them */
// loop: NOT-WORTH — the CLI's ~30 run options, once
const RUN = new Map([...args.matchAll(/\("([a-z-]+)", "([a-z_]+)", Kind::(\w+),/g)].map((m) => [m[1], [m[2], m[3]] as const]));
/** the flags that set no run option (docs/cli-parity.json "cli-only") */
const CLI_ONLY = new Set(Object.keys((JSON.parse(readFileSync(new URL("../../docs/cli-parity.json", import.meta.url), "utf8")) as { "cli-only": Record<string, string> })["cli-only"]));

/** Words as one Console line (quoted as typed). */
// loop: NOT-WORTH — a line's few words
export const lineOf = (words: readonly string[]) => words.map((w) => quoteArg(w, { windows: false })).join(" ");

/**
 * What the CLI hands the engine for a parsed line (run.rs render: RUN_OPTIONS, --outputs, --window, --frames / -s / -e,
 * exr by default; a frame folder whose first frame is EXR read scene-linear unless --no-linear). `-F a-b` alone: a
 * plain range.
 */
export function cliOptions(line: string, exrFrames = false): { input: string; output: string; options: Record<string, unknown> } {
  const p = parse(line, reg, { windows: false });
  expect(p.errors, line).toEqual([]);
  const o: Record<string, unknown> = {};
  let input = "";
  let output = "";
  // loop: NOT-WORTH — a line's few options
  for (const { arg, value } of p.options) {
    if (arg.id === "input") input = value!;
    else if (arg.id === "output") output = value!;
    else if (arg.id === "outputs") o.outputs = value!.split(",");
    else if (arg.id === "window") [o.hann_chunk, o.hann_stride] = value!.split("/").map(Number);
    else if (arg.id === "frames") [o.frame_start, o.frame_end] = value!.split("-").map(Number);
    else if (arg.id === "start") o.frame_start = Number(value);
    else if (arg.id === "end") o.frame_end = Number(value);
    else if (CLI_ONLY.has(`--${arg.id}`)) continue;
    else {
      const [key, kind] = RUN.get(arg.id)!;
      o[key] = kind === "On" ? true : kind === "Off" ? false : kind === "Number" ? Number(value) : value;
    }
  }
  o.output_format ??= "exr";
  if (exrFrames) o.frame_dir_linear ??= true;
  return { input, output, options: o };
}

/** The engine's own defaults for what a line leaves out (a switch not given, a flag at the CLI's default). */
export const ENGINE_DEFAULTS: Record<string, unknown> = {
  outputs: ["alpha", "fg"],
  exr_dtype: "half",
  despill_strength: 0.5,
  hint_quality: 0.95,
  carry_hint: true,
  cutout_linear: false,
  frame_dir_fps: 24,
  frame_dir_linear: false,
  low_vram: false,
  video_codec: "h264-crf12",
};

/** `got` and `want` give the engine the same options (a key left out is the engine's default). */
export function sameOptions(got: Record<string, unknown>, want: Record<string, unknown>, what: string): void {
  // loop: NOT-WORTH — the options of one job
  for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) expect(got[k] ?? ENGINE_DEFAULTS[k], `${k} in ${what}`).toEqual(want[k] ?? ENGINE_DEFAULTS[k]);
}

/**
 * Representative jobs for the round trips: between them every job setting is off its default (a test checks it, so a
 * new setting must join one), EXR and video, each codec, every output, both hint modes, automatic and manual memory,
 * video clips and frame folders (EXR and PNG). Paths without spaces: quoting has tests of its own.
 */
export const REPRESENTATIVE: { name: string; kind: "video" | "frames"; exrFrames: boolean; options: Partial<JobOptions> }[] = [
  {
    name: "sh010",
    kind: "video",
    exrFrames: false,
    options: {
      hintMode: "first-frame",
      hintFirstFrame: "/shots/sh010_hint.png",
      hintQuality: 0.8,
      carryHint: false,
      memory: { auto: false, hannChunk: 8, hannStride: 4, lowVram: true },
      outputs: ["alpha", "cutout"],
      outputFormat: "exr",
      exrDtype: "float",
      despillStrength: 0.3,
      cutoutLinear: true,
      vramLimitGb: 10,
      modelScale: 0.5,
      linearBrightness: 1.5,
      linearContrast: 1.2,
      linearContrastPivot: 0.2,
      deepInput: true,
    },
  },
  { name: "sh020", kind: "video", exrFrames: false, options: { hintMode: "video", hintVideo: "/shots/sh020_hint.mov", outputs: ["fg", "checker"], outputFormat: "video", videoCodec: "dnxhr444" } },
  {
    name: "sh030",
    kind: "video",
    exrFrames: false,
    options: { outputs: ["alpha", "fg", "checker", "cutout"], outputFormat: "video", videoCodec: "h264-crf12", memory: { auto: false, hannChunk: 16, hannStride: 8, lowVram: false } },
  },
  { name: "sh040", kind: "frames", exrFrames: true, options: { frameDirFps: 25, frameDirLinear: false, outputFormat: "exr", modelScale: 0.75 } },
  { name: "sh050", kind: "frames", exrFrames: false, options: { frameDirFps: 23.976, frameDirLinear: true, outputFormat: "video", linearBrightness: 2 } },
  { name: "sh060", kind: "frames", exrFrames: false, options: { frameDirLinear: false, outputFormat: "exr", exrDtype: "float" } },
];
