// A queue job as its corridorkey line (src/shared/console/jobCommand.ts): the line, read by the Console's own parser and
// mapped by the CLI's own table (ck-cli args.rs RUN_OPTIONS, read from the source), gives the engine exactly the options
// the queue sends it (queue.ts engineOptions).
import { execFileSync } from "node:child_process";
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

/** the line (a test fails on a job that has none) */
function lineOf(job: JobLike, trt: boolean, windows = false): string {
  const r = jobCommand(job, trt, windows);
  if ("error" in r) throw new Error(r.error);
  return r.line;
}

function same(job: JobLike, trt: boolean) {
  const line = lineOf(job, trt);
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
    expect(same(job({}), false)).toBe(`corridorkey render -i '/shots/sh010 plate.mov' -o /renders/sh010 --format video --codec h264-lossless`);
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

// senior review 2026-10-27 M3 (probe P7): "Copy as command" used "…" with $( ) and backticks left as they are, and %VAR%
// bare on Windows: a crafted folder name ran when the copied line was pasted into a terminal
describe("the copied line is safe to paste into a shell (review 2026-10-27 M3)", () => {
  const hostile = job({ hintMode: "video", hintVideo: "/h/$HOME/it's.mov" }, "video", "/shots/$(echo PWNED)/a `echo PWNED` %PATH% !x.mov");
  const evil = { ...hostile, outputDir: "/r/$(echo PWNED)" };

  it("Linux and macOS: single quotes ('\\'' for a quote), read back by sh and by the Console as the exact words", () => {
    const line = lineOf(evil, false);
    expect(line).toBe("corridorkey render -i '/shots/$(echo PWNED)/a `echo PWNED` %PATH% !x.mov' -o '/r/$(echo PWNED)' --format video --codec h264-lossless --hint-video '/h/$HOME/it'\\''s.mov'");
    // a real POSIX sh prints the words it would pass (no substitution ran: PWNED never appears on its own)
    const printed = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${line.slice("corridorkey ".length)}`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 });
    expect(printed.split("\n").slice(0, -1)).toEqual(["render", "-i", evil.clip.path, "-o", evil.outputDir, "--format", "video", "--codec", "h264-lossless", "--hint-video", "/h/$HOME/it's.mov"]);
    // and the Console reads the same
    expect(cliOptions(line)).toMatchObject({ input: evil.clip.path, output: evil.outputDir });
    // words a shell reads specially at a word's start stay quoted (# a comment, ~ home, = zsh's command path)
    expect(lineOf({ ...job({}), outputDir: "#r" }, false)).toContain("-o '#r'");
    expect(lineOf({ ...job({}), outputDir: "~r" }, false)).toContain("-o '~r'");
  });

  it('Windows: double quotes, and no line for a path cmd.exe or PowerShell would read ($ ` % ! ")', () => {
    expect(lineOf(job({}, "video", "D:\\my shots\\sh010.mov"), false, true)).toBe('corridorkey render -i "D:\\my shots\\sh010.mov" -o /renders/sh010 --format video --codec h264-lossless');
    // loop: NOT-WORTH — a test's few paths
    for (const p of ["C:\\shots\\%PATH%\\a.mov", "C:\\shots\\$(id)\\a.mov", "C:\\shots\\`id`.mov", "C:\\shots\\!x!.mov", 'C:\\a"b.mov']) {
      const r = jobCommand(job({}, "video", p), false, true);
      expect(r, p).toEqual({ error: expect.stringMatching(/cmd.exe and PowerShell would read .* no command line/) });
    }
  });

  it("no line for a control character (a new line would paste as two lines), on every system", () => {
    // loop: NOT-WORTH — two systems
    for (const windows of [false, true]) expect(jobCommand(job({}, "video", "/shots/a\ntouch PWNED"), false, windows)).toEqual({ error: expect.stringMatching(/control character/) });
  });
});
