// A queue job as its corridorkey line (src/shared/console/jobCommand.ts): the line, read by the Console's own parser and
// mapped by the CLI's own table (ck-cli args.rs RUN_OPTIONS, read from the source), gives the engine exactly the options
// the queue sends it (queue.ts engineOptions).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { engineOptions } from "../../electron/main/queue";
import { CLI_DEFAULTS, jobCommand, type JobLike } from "../../src/shared/console/jobCommand";
import { parse } from "../../src/shared/console/parse";
import { makeRegistry } from "../../src/shared/console/registry";
import cliSpec from "../../src/shared/console/cliSpec.json";
import { DEFAULT_OPTIONS, type JobOptions } from "../../src/shared/types";

const reg = makeRegistry();
const args = readFileSync(new URL("../../engine-rs/crates/ck-cli/src/args.rs", import.meta.url), "utf8");
/** flag → [run option, kind], as the CLI maps them */
// loop: NOT-WORTH — the CLI's ~30 run options, once
const RUN = new Map([...args.matchAll(/\("([a-z-]+)", "([a-z_]+)", Kind::(\w+),/g)].map((m) => [m[1], [m[2], m[3]] as const]));

/** What the CLI hands the engine for a parsed line (run.rs render: RUN_OPTIONS, --outputs, --window, exr by default). */
function cliOptions(line: string): { input: string; output: string; options: Record<string, unknown> } {
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
    else {
      const [key, kind] = RUN.get(arg.id)!;
      o[key] = kind === "On" ? true : kind === "Off" ? false : kind === "Number" ? Number(value) : value;
    }
  }
  o.output_format ??= "exr";
  return { input, output, options: o };
}

/** The engine's own defaults for what a line leaves out (a switch not given, a flag at the CLI's default). */
const ENGINE_DEFAULTS: Record<string, unknown> = {
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

function same(job: JobLike, trt: boolean) {
  const line = jobCommand(job, trt, false);
  const got = cliOptions(line);
  expect([got.input, got.output]).toEqual([job.clip.path, job.outputDir]);
  const want = engineOptions(job.options, job.clip.kind, trt);
  // loop: NOT-WORTH — the options of one job
  for (const k of new Set([...Object.keys(want), ...Object.keys(got.options)])) expect(got.options[k] ?? ENGINE_DEFAULTS[k], `${k} in ${line}`).toEqual(want[k] ?? ENGINE_DEFAULTS[k]);
  return line;
}

const job = (options: Partial<JobOptions>, kind: "video" | "frames" = "video", path = "/shots/sh010 plate.mov"): JobLike => ({
  clip: { path, kind },
  outputDir: "/renders/sh010",
  options: { ...DEFAULT_OPTIONS, ...options },
});

describe("a queue job as its corridorkey line (teach by echo)", () => {
  it("the defaults: the app's video outputs, flags only where they differ from the CLI's", () => {
    expect(same(job({}), false)).toBe(`corridorkey render -i "/shots/sh010 plate.mov" -o /renders/sh010 --format video --codec h264-lossless`);
  });

  it("every setting the queue sends maps to a flag that gives the engine the same value", () => {
    same(
      job({
        hintMode: "first-frame",
        hintFirstFrame: "/shots/hint.png",
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
      }),
      true,
    );
    same(job({ hintMode: "video", hintVideo: "/shots/hint.mov", outputFormat: "video", videoCodec: "dnxhr444" }), false);
    same(job({ frameDirFps: 25, frameDirLinear: true, outputFormat: "exr" }, "frames", "/shots/sh010/plates"), false);
    // the linear adjust is for video clips only (as the queue sends it)
    expect(same(job({ linearBrightness: 2 }, "frames", "/p"), false)).not.toContain("--brightness");
  });

  it("its defaults are the CLI's own (the help's [default: …])", () => {
    const render = cliSpec.commands.find((c) => c.name === "render")!;
    // loop: NOT-WORTH — eight defaults
    for (const [flag, v] of Object.entries(CLI_DEFAULTS)) expect(render.args.find((a) => a.long === flag)!.help, flag).toContain(`[default: ${v}]`);
  });
});
