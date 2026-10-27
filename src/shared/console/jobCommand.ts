// A queue job as its `corridorkey render …` line (Phase 4, teach by echo): the same mapping the queue sends the engine
// (queue.ts engineOptions), in the CLI's flags (ck-cli args.rs RUN_OPTIONS). A flag is written only where the job's value
// differs from the CLI's default (its help's "[default: …]"; tests/unit/jobCommand.test.ts checks both against the spec
// and that the line, parsed by the Console, gives the engine the same options). Pure.
import type { ClipKind, JobOptions } from "../types";
import { quoteArg } from "./parse";

export interface JobLike {
  clip: { path: string; kind: ClipKind };
  outputDir: string;
  options: JobOptions;
}

/** The CLI's defaults for the flags a job may set (its help says each one). */
export const CLI_DEFAULTS = {
  outputs: "alpha,fg",
  format: "exr",
  codec: "h264-crf12",
  datatype: "half",
  despill: 0.5,
  "hint-quality": 0.95,
  fps: 24,
  "model-scale": 1,
} as const;

/** One flag: its long name (without --) and value (null: a switch). */
export type Flag = [name: string, value: string | null];

/**
 * The job's settings as render flags, in a fixed order, only those that differ from the CLI's defaults. `tensorrt`: the
 * queue asked the engine for TensorRT (a machine's choice, made when the job starts).
 */
export function jobFlags(o: JobOptions, kind: ClipKind, tensorrt: boolean): Flag[] {
  const f: Flag[] = [];
  const num = (name: keyof typeof CLI_DEFAULTS, v: number) => v !== CLI_DEFAULTS[name] && f.push([name, String(v)]);
  // loop: NOT-WORTH — ≤ four outputs
  if (o.outputs.join(",") !== CLI_DEFAULTS.outputs) f.push(["outputs", o.outputs.join(",")]);
  if (o.outputFormat !== CLI_DEFAULTS.format) f.push(["format", o.outputFormat]);
  if (o.outputFormat === "video" && o.videoCodec !== CLI_DEFAULTS.codec) f.push(["codec", o.videoCodec]);
  if (o.exrDtype !== CLI_DEFAULTS.datatype) f.push(["datatype", o.exrDtype]);
  num("despill", o.despillStrength);
  if (o.cutoutLinear) f.push(["cutout-linear", null]);
  if (o.hintMode === "first-frame" && o.hintFirstFrame) f.push(["hint", o.hintFirstFrame]);
  if (o.hintMode === "video" && o.hintVideo) f.push(["hint-video", o.hintVideo]);
  num("hint-quality", o.hintQuality);
  if (!o.carryHint) f.push(["no-carry-hint", null]);
  if (!o.memory.auto) {
    f.push(["window", `${o.memory.hannChunk}/${o.memory.hannStride}`]);
    if (o.memory.lowVram) f.push(["low-vram", null]);
  }
  if (o.vramLimitGb !== null) f.push(["max-vram", String(o.vramLimitGb)]);
  if (kind === "frames") {
    num("fps", o.frameDirFps);
    if (o.frameDirLinear) f.push(["linear", null]);
  }
  num("model-scale", o.modelScale);
  if (kind === "video" && (o.linearBrightness !== 1 || o.linearContrast !== 1))
    f.push(["brightness", String(o.linearBrightness)], ["contrast", String(o.linearContrast)], ["contrast-pivot", String(o.linearContrastPivot)]);
  if (o.deepInput) f.push(["input-bit-depth", "16"]);
  if (tensorrt) f.push(["tensorrt", null], ["no-tensorrt-build", null]);
  return f;
}

/** Flags as words: --name value. */
// loop: NOT-WORTH — a job's few flags
export const flagWords = (flags: readonly Flag[]): string[] => flags.flatMap(([n, v]) => (v === null ? [`--${n}`] : [`--${n}`, v]));

/** The job's render arguments (after `corridorkey`). */
export function jobArgs(job: JobLike, tensorrt: boolean): string[] {
  // the folder as it is (no trailing separator: on Windows a quoted "D:\key\" would end its quote for cmd.exe)
  return ["render", "-i", job.clip.path, "-o", job.outputDir, ...flagWords(jobFlags(job.options, job.clip.kind, tensorrt))];
}

/** The job as one line, quoted as the Console (and a shell) reads it: corridorkey render -i … -o … */
export function jobCommand(job: JobLike, tensorrt: boolean, windows: boolean): string {
  // loop: NOT-WORTH — a job's few words
  return ["corridorkey", ...jobArgs(job, tensorrt).map((w) => quoteArg(w, { windows }))].join(" ");
}
