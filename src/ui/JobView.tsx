// A running or finished job: the stages, the measured numbers, the results.
import { useEffect, useState } from "react";
import { FolderOpen, RotateCcw } from "lucide-react";
import type { Job } from "../shared/types";
import { duration, remaining, STAGE_ORDER, STAGE_TEXT } from "./format";

export function JobView({ job }: { job: Job }) {
  // A 1 s tick for the elapsed clock, only while this job runs and the page is visible (rule 3).
  const [, tick] = useState(0);
  useEffect(() => {
    if (job.status !== "running") return;
    // lifetime: OK — cleared when the job stops running or the view unmounts
    // loop: HOT-PATH-OK — one re-render per second while a job runs and the page is visible
    const t = setInterval(() => document.visibilityState === "visible" && tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [job.status]);
  const pct = job.framesTotal ? Math.min(100, (job.framesDone / job.framesTotal) * 100) : 0;
  const left = remaining(job);
  const elapsed = job.startedAt ? ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000 : null;
  const nowIdx = job.stage ? STAGE_ORDER.indexOf(job.stage) : -1;
  const m = job.memory;

  return (
    <>
      {job.status === "running" && (
        <section className="section">
          <h3>Progress</h3>
          <div className="stages">
            {STAGE_ORDER.filter((s) => s !== "foundations" || job.memory?.lowVram).map((s) => {
              const i = STAGE_ORDER.indexOf(s);
              return (
                <span key={s} className={`stage ${i === nowIdx ? "now" : i < nowIdx ? "past" : ""}`}>
                  {STAGE_TEXT[s]}
                </span>
              );
            })}
          </div>
          <div className="bar big" role="progressbar" aria-valuemin={0} aria-valuemax={job.framesTotal ?? 0} aria-valuenow={job.framesDone}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="stats">
            <Stat k="Frames written" v={job.framesTotal ? `${job.framesDone} / ${job.framesTotal}` : String(job.framesDone)} />
            <Stat k="Speed (measured)" v={job.framesPerSecond ? `${job.framesPerSecond.toFixed(2)} fps` : "measuring…"} />
            <Stat k="Time left" v={left !== null ? `about ${duration(left)}` : "after the first frames"} />
            <Stat k="Elapsed" v={elapsed !== null ? duration(elapsed) : "—"} />
            {job.stageDetail && <Stat k="Stage 1" v={job.stageDetail} />}
          </div>
        </section>
      )}

      {m && (
        <section className="section">
          <h3>Memory used for this job</h3>
          <div className="stats">
            <Stat k="Temporal window" v={`${m.hannChunk} / ${m.hannStride}`} />
            <Stat k="Low-memory mode" v={m.lowVram ? "on" : "off"} />
            <Stat k="Chosen" v={m.auto ? "automatically" : "manually"} />
            {m.budgetGb !== null && <Stat k="Free when it started" v={`${m.budgetGb.toFixed(1)} GB`} />}
            {m.estimateGb !== null && <Stat k="Runtime's peak estimate" v={`${m.estimateGb.toFixed(1)} GB`} />}
          </div>
        </section>
      )}

      {job.status === "done" && (
        <section className="section">
          <h3>Results</h3>
          {job.stills.length > 0 && (
            <div className="stills">
              {job.stills.map((s) => (
                <figure key={s.output}>
                  <img src={s.url} alt={`${s.output}, middle frame`} width={320} />
                  <figcaption>{s.output} · middle frame</figcaption>
                </figure>
              ))}
            </div>
          )}
          <ul className="outputs">
            {job.outputs.map((f) => (
              <li key={f}>
                <span className="path">{f}</span>
                <button className="icon-btn" aria-label="Show in folder" title="Show in folder" onClick={() => window.ck.showInFolder(f)}>
                  <FolderOpen size={14} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(job.status === "failed" || job.status === "cancelled") && (
        <section className={`notice ${job.status === "failed" ? "error" : "warn"}`} style={{ margin: "18px 0 0" }}>
          <h3>{job.status === "failed" ? errorTitle(job.error?.code) : "Cancelled"}</h3>
          <div>{job.status === "failed" ? job.error?.message : "The job was stopped. Files it had started writing stay in the output folder, incomplete."}</div>
          {job.error?.code === "oom" && <p className="hint-text">Try Manual memory with a smaller window and low-memory mode, or close other programs that use the graphics card.</p>}
          <p>
            <button className="btn small" onClick={() => window.ck.retryJob(job.id)}>
              <RotateCcw size={14} /> Run again
            </button>
          </p>
          {job.error && job.error.stderrTail.length > 0 && (
            <details>
              <summary>Engine output</summary>
              <pre className="log">{job.error.stderrTail.join("\n")}</pre>
            </details>
          )}
        </section>
      )}

      {job.log.length > 0 && (
        <section className="section">
          <details>
            <summary>Engine log ({job.log.length} lines)</summary>
            <pre className="log">{job.log.join("\n")}</pre>
          </details>
        </section>
      )}
    </>
  );
}

function errorTitle(code: string | undefined): string {
  switch (code) {
    case "oom":
      return "The graphics card ran out of memory";
    case "input":
      return "The clip or a hint couldn't be read";
    case "assets":
      return "Model files are missing";
    case "no-gpu":
      return "No NVIDIA graphics card found";
    default:
      return "The job failed";
  }
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}
