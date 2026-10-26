// The engine log saved with every job (backlog row 55): `<clip>_log.txt` next to the results (`_log_failed.txt` /
// `_log_cancelled.txt` for a run that didn't finish), like the engine's
// `<clip>_settings.txt`, written by the app when the job ends (done, failed or cancelled: a cancel kills the engine,
// so the engine can't write it). What ran it comes first ("Technology for this run" and the memory the job used, as
// the job page shows them), then the whole log, then the engine's last error output when it failed. Copy log on the
// job page copies the same text.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Job } from "../../src/shared/types";
import { duration, ranOnText, trtJobText } from "../../src/ui/format";
import { rangeText } from "../../src/shared/trt";

/** The engines' clip name (engine-rs clip.rs raw_clip_name, the original's): the file name without its extension
 * (os.path.splitext: leading dots aren't one), or the parent folder's name for a folder called input / frames / rgb. */
export function clipStem(path: string): string {
  const norm = path.replace(/[\\/]+$/, "");
  const base = basename(norm);
  const lead = /^\.*/.exec(base)![0].length;
  const dot = base.lastIndexOf(".");
  const name = dot > lead ? base.slice(0, dot) : base;
  if (["input", "frames", "rgb"].includes(name.toLowerCase())) {
    const parent = basename(norm.slice(0, norm.length - base.length).replace(/[\\/]+$/, ""));
    if (parent) return parent;
  }
  return name;
}

/** Where a job's log goes: `<output folder>/<clip>_log.txt` for a finished run; `_log_failed.txt` / `_log_cancelled.txt`
 * for one that didn't finish, so the finished results' own log stays next to them (bug hunt 2026-10-26 M1). */
export const jobLogPath = (job: Job) => join(job.outputDir, `${clipStem(job.clip.path)}_log${job.status === "failed" ? "_failed" : job.status === "cancelled" ? "_cancelled" : ""}.txt`);

const when = (ms: number | null) => (ms === null ? "—" : new Date(ms).toISOString());

/** The log file's text: the job, what ran it, the whole log, and the engine's error output on a failure. */
export function jobLogText(job: Job, appVersion: string): string {
  const t = job.tech ?? null;
  const m = job.memory;
  const status = job.status === "failed" ? `failed: ${job.error?.message ?? "unknown error"}` : job.status;
  const lines = [
    `CorridorKey Desktop ${appVersion}: engine log`,
    `Clip: ${job.clip.path}`,
    `Results folder: ${job.outputDir}`,
    `Status: ${status}`,
    `Started: ${when(job.startedAt)}`,
    `Ended: ${when(job.finishedAt)}${job.startedAt && job.finishedAt ? ` (${duration((job.finishedAt - job.startedAt) / 1000)})` : ""}`,
    "",
    "Technology for this run",
    `  Ran on: ${(t && ranOnText(t)) ?? "not reported by the engine"}`,
    `  Precision: ${t?.precision ?? "not reported by the engine"}`,
    `  TensorRT: ${(t && trtJobText(t)) ?? "not asked"}`,
    `  TensorRT range: ${t?.range ? `${t.range} (${rangeText(t.range)})` : "none"}`,
    `  Temporal window: ${m ? `${m.hannChunk} / ${m.hannStride} (chosen ${m.auto ? "automatically" : "manually"})` : "not reported (the job ended before the engine chose it)"}`,
    `  Low-memory mode: ${m ? (m.lowVram ? "on" : "off") : "not reported"}`,
    `  Free graphics memory when it started: ${m?.freeGb != null ? `${m.freeGb.toFixed(1)} GiB` : m?.budgetGb != null ? `${m.budgetGb.toFixed(1)} GiB (budget)` : "not reported"}`,
    `  Graphics memory limit: ${m?.limitGb != null ? `${m.limitGb.toFixed(1)} GiB` : "none (Auto)"}`,
    `  Runtime's peak estimate: ${m?.estimateGb != null ? `${m.estimateGb.toFixed(1)} GiB` : "not reported"}`,
    "",
    `Engine log (${job.log.length} lines${job.logDropped ? `; the first ${job.logDropped} lines were dropped: the log was longer than the app keeps` : ""})`,
    ...job.log,
  ];
  if (job.error && job.error.stderrTail.length > 0) lines.push("", `The engine's last error output (code ${job.error.code})`, ...job.error.stderrTail);
  return `${lines.join("\n")}\n`;
}

/** Writes a finished job's log next to its results (making the folder if a failed job's discard removed it). */
export function saveJobLog(job: Job, appVersion: string): { path: string; error: string | null } {
  const path = jobLogPath(job);
  try {
    // loop: NOT-WORTH — one small text file per finished job
    mkdirSync(job.outputDir, { recursive: true });
    // loop: NOT-WORTH — as above
    writeFileSync(path, jobLogText(job, appVersion));
    return { path, error: null };
  } catch (e) {
    // error: SHOWN — the job page says the log couldn't be saved, and why (Copy log still works)
    return { path, error: (e as Error).message };
  }
}
