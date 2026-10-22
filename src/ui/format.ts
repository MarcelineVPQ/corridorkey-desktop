// Text for numbers shown in the UI. Measured values only; when something
// isn't known yet the UI says so instead of guessing (rule 1).
import type { ClipInfo, Job, Stage } from "../shared/types";

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

/** Time left from the measured frame rate, or null while there is no measured rate. */
export function remaining(job: Job): number | null {
  if (!job.framesPerSecond || !job.framesTotal) return null;
  return (job.framesTotal - job.framesDone) / job.framesPerSecond;
}

export const STAGE_TEXT: Record<Stage, string> = {
  start: "Starting the engine",
  load: "Loading the model",
  probe: "Reading the clip",
  rvm: "Motion features (RVM)",
  foundations: "Foundation features",
  keying: "Keying",
};

export const STAGE_ORDER: Stage[] = ["start", "load", "probe", "rvm", "foundations", "keying"];

export function statusText(job: Job): string {
  switch (job.status) {
    case "waiting":
      return job.clip.probeError ? "Can't read this clip" : "Waiting";
    case "running":
      if (job.stage === "keying" && job.framesTotal) return `${job.framesDone} / ${job.framesTotal} frames`;
      return job.stage ? STAGE_TEXT[job.stage] : "Starting";
    case "done":
      return job.startedAt && job.finishedAt ? `Done in ${duration((job.finishedAt - job.startedAt) / 1000)}` : "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

export function gb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}
