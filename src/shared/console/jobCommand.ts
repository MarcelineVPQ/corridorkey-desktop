// A queue job as its `corridorkey render …` line (Phase 4, teach by echo): the same mapping the queue sends the engine
// (queue.ts engineOptions), in the CLI's flags (ck-cli args.rs RUN_OPTIONS). A flag is written only where the job's value
// differs from the CLI's default (its help's "[default: …]"; tests/unit/jobCommand.test.ts checks both against the spec
// and that the line, parsed by the Console, gives the engine the same options), except an EXR frame folder's
// --linear / --no-linear, written both ways. Pure.
import type { ClipKind, JobOptions } from "../types";

export interface JobLike {
  clip: { path: string; kind: ClipKind; exrFrames: boolean };
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
export function jobFlags(o: JobOptions, clip: Pick<JobLike["clip"], "kind" | "exrFrames">, tensorrt: boolean): Flag[] {
  const kind = clip.kind;
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
    // the CLI reads an EXR folder scene-linear by default (others display-coded): for EXR the choice is written both
    // ways, so the line says it on any CLI version (one from before --no-linear refuses it rather than guess; Marcy
    // 2026-10-27)
    if (clip.exrFrames) f.push([o.frameDirLinear ? "linear" : "no-linear", null]);
    else if (o.frameDirLinear) f.push(["linear", null]);
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
  return ["render", "-i", job.clip.path, "-o", job.outputDir, ...flagWords(jobFlags(job.options, job.clip, tensorrt))];
}

/**
 * A word quoted so that a shell and the Console both read it back as `value` (senior review 2026-10-27 M3: the line is
 * pasted into terminals). Linux and macOS: plain when it has only characters no shell reads specially, else in single
 * quotes (a `'` as `'\\''`), where bash and zsh expand nothing. Windows: plain, else in double quotes; no quoting
 * keeps cmd.exe from reading `%…%` (and `!` with delayed expansion) or PowerShell from reading `$` and a backtick
 * inside `"…"`, so a word with one of them (or a `"`) is an error. A control character is one everywhere (a new line
 * pastes as two lines).
 */
export function shellWord(value: string, windows: boolean): { word: string } | { error: string } {
  if (/[\u0000-\u001f\u007f]/.test(value)) return { error: `${JSON.stringify(value)} has a control character (a new line, a tab): no command line is offered for this job` };
  if (windows) {
    if (/[%!$`"]/.test(value))
      return {
        error: `${value} has ${value.match(/[%!$`"]/)![0]} in it, which cmd.exe and PowerShell would read as part of a variable or a command: no command line is offered for this job (rename it to copy one)`,
      };
    return { word: value !== "" && /^[\p{L}\p{N}_\-./\\:]+$/u.test(value) ? value : `"${value}"` };
  }
  return { word: value !== "" && value !== "--" && /^[\p{L}\p{N}_\-./:@%+,]+$/u.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'` };
}

/** The job as one line a shell and the Console read the same: corridorkey render -i … -o …; or why there is none. */
export function jobCommand(job: JobLike, tensorrt: boolean, windows: boolean): { line: string } | { error: string } {
  return commandLine(jobArgs(job, tensorrt), windows);
}

/**
 * `corridorkey` and its arguments as one line for a terminal or a farm's task (each word quoted by shellWord; `--`
 * bare, where it ends the options): Copy as command, and a Console block's Copy as farm line (SME review 2026-10-26 N7).
 */
export function commandLine(args: readonly string[], windows: boolean): { line: string } | { error: string } {
  const words = ["corridorkey"];
  // loop: NOT-WORTH — a command's few words
  for (const w of args) {
    const q = w === "--" ? { word: w } : shellWord(w, windows);
    if ("error" in q) return q;
    words.push(q.word);
  }
  return { line: words.join(" ") };
}
