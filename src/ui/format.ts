// Text for numbers shown in the UI. Measured values only; when something
// isn't known yet the UI says so instead of guessing (rule 1).
import type { ClipInfo, Job, JobTech, Stage } from "../shared/types";
import { CANT_READ_CLIP } from "../shared/texts";
import { PIECE_NAMES, rangeText } from "../shared/trt";

export function clipFacts(c: ClipInfo): string {
  const parts: string[] = [];
  if (c.width && c.height) parts.push(`${c.width}×${c.height}`);
  if (c.fps) parts.push(`${+c.fps.toFixed(3)} fps`);
  if (c.frames) parts.push(`${c.frames} frames`);
  if (c.kind === "frames") parts.push("frame folder");
  return parts.join(" · ");
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

export const STAGE_TEXT: Record<Stage, string> = {
  start: "Starting the engine",
  load: "Loading the model",
  optimize: "Optimizing for this resolution (one-time TensorRT build)",
  probe: "Reading the clip",
  rvm: "Motion features (RVM)",
  foundations: "Foundation features",
  keying: "Keying",
};

export const STAGE_ORDER: Stage[] = ["start", "load", "probe", "optimize", "rvm", "foundations", "keying"];

export function statusText(job: Job): string {
  switch (job.status) {
    case "waiting":
      return job.clip.probeError ? CANT_READ_CLIP : "Waiting";
    case "running":
      if (job.stage === "keying" && job.framesTotal) return `${job.framesDone} / ${job.framesTotal} frames`;
      return job.stage ? STAGE_TEXT[job.stage] : "Starting";
    case "done": {
      const ran = providerName(job.tech?.provider ?? null);
      const done = job.startedAt && job.finishedAt ? `Done in ${duration((job.finishedAt - job.startedAt) / 1000)}` : "Done";
      return ran ? `${done} · ${ran}` : done;
    }
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

/** The engine's provider name on screen ("tensorrt+cuda" → "TensorRT + CUDA"); null when the engine sent none. */
export function providerName(p: string | null): string | null {
  if (!p) return null;
  const names: Record<string, string> = { cuda: "CUDA", tensorrt: "TensorRT", "tensorrt+cuda": "TensorRT + CUDA", cpu: "CPU", coreml: "Core ML" };
  return names[p] ?? p;
}

/** What ran a job, from the engine's provider replies: "TensorRT + CUDA · fp16 (stage 1 on CUDA)". */
export function ranOnText(t: JobTech): string | null {
  const name = providerName(t.provider);
  if (!name) return null;
  // loop: NOT-WORTH — at most five networks
  const onCuda = Object.keys(t.fallbacks).map((k) => PIECE_NAMES[k] ?? k);
  const partly = t.provider === "tensorrt+cuda" && onCuda.length ? ` (${onCuda.join(", ")} on CUDA)` : "";
  return `${name}${t.precision ? ` · ${t.precision}` : ""}${partly}`;
}

/** The TensorRT line of a job: why it wasn't used (the engine's reason, or the app's), or the range it ran. */
export function trtJobText(t: JobTech): string | null {
  if (t.notAsked) return `not asked: ${t.notAsked}`;
  if (!t.tensorrtRequested) return null;
  if (t.fallbackReason) return `not used: ${t.fallbackReason}`;
  // loop: NOT-WORTH — at most five networks
  const fell = Object.entries(t.fallbacks).map(([k, why]) => `${PIECE_NAMES[k] ?? k} on CUDA (${why})`);
  if (t.range) return `range ${rangeText(t.range)}, ${t.cache === "build" ? "built in this job" : "built before"}${fell.length ? `; ${fell.join("; ")}` : ""}`;
  return null;
}

// decimal GB for disks and downloads: one definition, shared with the main process
export { gbBytes } from "../shared/units";

/** Graphics memory in GiB (2^30 bytes), from the driver's MiB: the unit cards are sold in ("16 GB" = 16 GiB). */
export function gib(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GiB`;
}
