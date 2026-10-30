// The selected clip in the Queue page's main view: its progress, the memory
// window it used, its results, its error and the engine log, as MainBlocks
// (readouts are always shown, never folded).
import { useEffect, useState } from "react";
import { ProgressBar } from "./ProgressBar";
import { FolderOpen, RotateCcw, Zap } from "lucide-react";
import { LOG_SHOWN, type Job, type TrtPrebuild } from "../shared/types";
import { buildSteps, fixedByBuild, prebuildStep, trtSizeKey } from "../shared/trt";
import { duration, ranOnText, STAGE_ORDER, stageText, trtJobText } from "./format";
import { MainBlock } from "./panel/SplitView";
import { PathText } from "./PathText";

// `trtOn`: TensorRT is on and installed here (Build it now builds only then; otherwise the tile says how to turn it on)
export function JobView({ job, prebuild, trtOn = false }: { job: Job; prebuild?: TrtPrebuild; trtOn?: boolean }) {
  // A 1 s tick for the elapsed clock, only while this job runs and the page is visible (rule 3).
  const [, tick] = useState(0);
  useEffect(() => {
    if (job.status !== "running") return;
    // lifetime: OK — cleared when the job stops running or the view unmounts
    // loop: HOT-PATH-OK — one re-render per second while a job runs and the page is visible
    const t = setInterval(() => document.visibilityState === "visible" && tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [job.status]);

  const elapsed = job.startedAt ? ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000 : null;
  const nowIdx = job.stage ? STAGE_ORDER.indexOf(job.stage) : -1;
  const m = job.memory;
  // what ran it, from the engine's provider replies (and the app's reason when it didn't ask for TensorRT)
  const tech = job.tech ?? null;
  const ranOn = tech ? ranOnText(tech) : null;
  const trtLine = tech ? trtJobText(tech) : null;
  // the tile says the version; its folder goes on its own line, shortened like every path (a full path overflowed the tile)
  const modelSet = tech && (tech.modelSet || tech.modelsDir) ? (tech.modelSet ?? "no version (its folder has no manifest.json)") : null;
  const steps = prebuild ? buildSteps(prebuild.ranges) : null;
  // no TensorRT engine served this clip, and building its size fixes that (1.0.0-dev.7: the tile offers it)
  const notBuilt = Boolean(tech?.tensorrtRequested && fixedByBuild(tech.fallbackReason, tech.fallbacks));
  const { width, height } = job.clip;
  const sizeKey = width && height && job.options.modelScale === 1 ? trtSizeKey(width, height) : null;
  // the last build of this size failed (short of memory, review 2026-10-29 M2): the tile says why, and the button retries
  // loop: HOT-PATH-OK — the few chosen sizes per render
  const failed = sizeKey ? prebuild?.ranges.find((r) => trtSizeKey(r.width, r.height) === sizeKey && r.state === "failed") : undefined;
  // built by the background build since (this session): the next run uses it
  // loop: HOT-PATH-OK — the few chosen sizes per render
  const builtSince = Boolean(sizeKey && prebuild?.ranges.some((r) => trtSizeKey(r.width, r.height) === sizeKey && r.state === "done" && r.range !== null));
  // asked for while the queue runs: the build waits for the queue (paused)
  // loop: HOT-PATH-OK — the few chosen sizes per render
  const queued = Boolean(sizeKey && prebuild?.status === "paused" && prebuild.ranges.some((r) => trtSizeKey(r.width, r.height) === sizeKey && r.state === "todo"));
  const offer = notBuilt && prebuild?.status !== "running" && !builtSince && !queued && trtOn;

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
                  {stageText(job, s)}
                </span>
              );
            })}
          </div>
          <ProgressBar label="Frames written" value={job.framesDone} max={job.framesTotal ?? 0} big />
          <div className="stats">
            <Stat k="Frames written" v={job.framesTotal ? `${job.framesDone} / ${job.framesTotal}` : String(job.framesDone)} />
            <Stat k="Speed (measured)" v={job.framesPerSecond ? `${job.framesPerSecond.toFixed(2)} fps` : "measuring…"} />
            <Stat k="Elapsed" v={elapsed !== null ? duration(elapsed) : "—"} />
            {job.stageDetail && <Stat k={job.stage ? stageText(job, job.stage) : "Detail"} v={job.stageDetail} />}
          </div>
        </MainBlock>
      )}

      {tech && (ranOn || trtLine || modelSet) && (
        <MainBlock title="Technology for this run">
          <div className="stats">
            {ranOn && <Stat k="Ran on" v={ranOn} />}
            {modelSet && <Stat k="Model set" v={modelSet} />}
            {trtLine && <Stat k="TensorRT" v={trtLine} />}
          </div>
          {tech?.modelsDir && (
            <p className="hint-text">
              Model set folder: <PathText path={tech.modelsDir} />
            </p>
          )}
          {notBuilt && prebuild?.status === "running" && (
            <p className="hint-text">{`It builds in the background now: ${prebuildStep(prebuild.ranges) ?? "starting"}. Clips after it run on TensorRT.`}</p>
          )}
          {notBuilt && builtSince && prebuild?.status !== "running" && <p className="hint-text">Built for this size now: the next run of this clip uses TensorRT.</p>}
          {notBuilt && queued && <p className="hint-text">TensorRT for this size builds in the background once the queue stops.</p>}
          {notBuilt && !trtOn && <p className="hint-text">TensorRT is off or not installed now: turn it on in Engine settings → TensorRT, and this page offers to build it.</p>}
          {offer && failed && <p className="hint-text">{`The last build couldn't finish: ${failed.error}.`}</p>}
          {offer && sizeKey && width && height && (
            <div className="gap-top">
              {/* the same background build as Engine settings → TensorRT, for this clip's size; no time: none is measured
                  for the range it builds (review 2026-10-29 M3) */}
              <button type="button" className="btn small" onClick={() => void window.ck.trtSize("build", { label: job.clip.name, width, height })}>
                <Zap size={14} aria-hidden /> {failed ? "Build it again" : "Build it now"}
              </button>
              <p className="hint-text">
                Builds TensorRT for {width}×{height} in the background, once. The next run of this clip uses it.
              </p>
            </div>
          )}
          {offer && !sizeKey && <p className="hint-text">Choose this size in Engine settings → TensorRT to build it in the background; until then clips of this size run on CUDA.</p>}
          {notBuilt && tech!.fallbackReason && <p className="hint-text">Why: {tech!.fallbackReason}.</p>}
          {notBuilt && prebuild?.status === "running" && steps && <ProgressBar label="TensorRT networks built" value={steps.done} max={steps.total} />}
        </MainBlock>
      )}

      {m && (
        <MainBlock title="Memory used for this run">
          <div className="stats">
            <Stat k="Temporal window" v={`${m.hannChunk} / ${m.hannStride}`} />
            <Stat k="Low-memory mode" v={m.lowVram ? "on" : "off"} />
            <Stat k="Chosen" v={m.auto ? "automatically" : "manually"} />
            {/* the engine says the free memory and the limit apart; a reply with only its budget (the free memory, capped by a limit) shows that */}
            {m.freeGb !== null ? (
              <Stat k="Free when it started" v={`${m.freeGb.toFixed(1)} GiB`} />
            ) : (
              m.budgetGb !== null && <Stat k={job.options.vramLimitGb !== null ? "Budget (free memory, within the limit)" : "Free when it started"} v={`${m.budgetGb.toFixed(1)} GiB`} />
            )}
            {m.limitGb !== null && <Stat k="Graphics memory limit" v={`${m.limitGb.toFixed(1)} GiB`} />}
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
                <PathText path={f} />
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
    case "output":
      return "The results couldn't be written";
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
