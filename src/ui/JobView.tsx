// The selected clip in the Queue page's main view: its progress, the memory
// window it used, its results, its error and the engine log, as MainBlocks
// (readouts are always shown, never folded).
import { useEffect, useState } from "react";
import { ProgressBar } from "./ProgressBar";
import { FolderOpen, RotateCcw } from "lucide-react";
import { LOG_SHOWN, type Job } from "../shared/types";
import { duration, remaining, STAGE_ORDER, STAGE_TEXT } from "./format";
import { MainBlock } from "./panel/SplitView";

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

  const left = remaining(job);
  const elapsed = job.startedAt ? ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000 : null;
  const nowIdx = job.stage ? STAGE_ORDER.indexOf(job.stage) : -1;
  const m = job.memory;

  return (
    <>
      {job.status === "running" && (
        <MainBlock title="Progress">
          <div className="stages">
            {/* loop: HOT-PATH-OK — ≤ seven stages per render (≤ 10/s while a job runs and the page is shown) */}
            {STAGE_ORDER.filter((s) => (s !== "foundations" || job.memory?.lowVram) && (s !== "optimize" || job.stage === "optimize")).map((s) => {
              const i = STAGE_ORDER.indexOf(s);
              return (
                <span key={s} className={`stage ${i === nowIdx ? "now" : i < nowIdx ? "past" : ""}`}>
                  {STAGE_TEXT[s]}
                </span>
              );
            })}
          </div>
          <ProgressBar value={job.framesDone} max={job.framesTotal ?? 0} big />
          <div className="stats">
            <Stat k="Frames written" v={job.framesTotal ? `${job.framesDone} / ${job.framesTotal}` : String(job.framesDone)} />
            <Stat k="Speed (measured)" v={job.framesPerSecond ? `${job.framesPerSecond.toFixed(2)} fps` : "measuring…"} />
            <Stat k="Time left" v={left !== null ? `about ${duration(left)}` : "after the first frames"} />
            <Stat k="Elapsed" v={elapsed !== null ? duration(elapsed) : "—"} />
            {job.stageDetail && <Stat k="Stage 1" v={job.stageDetail} />}
          </div>
        </MainBlock>
      )}

      {m && (
        <MainBlock title="Memory used for this run">
          <div className="stats">
            <Stat k="Temporal window" v={`${m.hannChunk} / ${m.hannStride}`} />
            <Stat k="Low-memory mode" v={m.lowVram ? "on" : "off"} />
            <Stat k="Chosen" v={m.auto ? "automatically" : "manually"} />
            {m.budgetGb !== null && <Stat k="Free when it started" v={`${m.budgetGb.toFixed(1)} GiB`} />}
            {m.estimateGb !== null && <Stat k="Runtime's peak estimate" v={`${m.estimateGb.toFixed(1)} GiB`} />}
          </div>
        </MainBlock>
      )}

      {job.status === "done" && (
        <MainBlock title="Results">
          {job.stills.length > 0 && (
            <div className="stills">
              {/* loop: HOT-PATH-OK — ≤ four stills per render */}
              {job.stills.map((s) => (
                <figure key={s.output}>
                  <img src={s.url} alt={`${s.output}, middle frame`} width={320} />
                  <figcaption>{s.output} · middle frame</figcaption>
                </figure>
              ))}
            </div>
          )}
          <ul className="outputs">
            {/* loop: HOT-PATH-OK — ≤ four outputs per render */}
            {job.outputs.map((f) => (
              <li key={f}>
                <span className="path">{f}</span>
                <button type="button" className="icon-btn" aria-label="Show in folder" title="Show in folder" onClick={() => window.ck.showInFolder(f)}>
                  <FolderOpen size={14} />
                </button>
              </li>
            ))}
          </ul>
        </MainBlock>
      )}

      {(job.status === "failed" || job.status === "cancelled") && (
        <section className={`notice ${job.status === "failed" ? "error" : "warn"}`}>
          <h3>{job.status === "failed" ? errorTitle(job.error?.code) : "Cancelled"}</h3>
          <div>{job.status === "failed" ? job.error?.message : "Stopped."}</div>
          {job.partial && <p className="hint-text">{job.partial}</p>}
          {job.error?.code === "oom" && <p className="hint-text">Try Manual memory with a smaller window and low-memory mode, or close other programs using the graphics card.</p>}
          <p>
            <button type="button" className="btn small" onClick={() => window.ck.retryJob(job.id)}>
              <RotateCcw size={14} /> Run again
            </button>
          </p>
          {job.error && job.error.stderrTail.length > 0 && <pre className="log">{job.error.stderrTail.join("\n")}</pre>}
        </section>
      )}

      {job.log.length > 0 && (
        <MainBlock title={`Engine log · last ${Math.min(LOG_SHOWN, job.log.length)} of ${job.logLines ?? job.log.length} lines`}>
          <pre className="log">{job.log.slice(-LOG_SHOWN).join("\n")}</pre>
        </MainBlock>
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
      return "No supported graphics card found";
    default:
      return "The job failed";
  }
}

export function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}
