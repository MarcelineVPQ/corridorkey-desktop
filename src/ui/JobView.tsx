// The selected clip in the Queue page's main view: what a waiting clip will use,
// a running clip's progress, the memory window it used, its results, its error
// and the engine log, as MainBlocks (readouts are always shown, never folded).
// Tiles hold short values; a reason goes on one line under its tiles (Notes).
import { useEffect, useState } from "react";
import { ProgressBar } from "./ProgressBar";
import { FolderOpen, RotateCcw } from "lucide-react";
import { LOG_SHOWN, scaledSize, type EngineKind, type Job, type TrtPrebuild, type TrtState } from "../shared/types";
import { gibBytes } from "../shared/units";
import { prebuildStep, TRT_NOT_BUILT } from "../shared/trt";
import { duration, providerName, ranOnParts, remaining, STAGE_ORDER, STAGE_TEXT, trtJobParts, type ValueWhy } from "./format";
import { CODEC_TEXT, estimateText, OUTPUT_TEXT, SCALE_TEXT, trtPlanFor, useEstimate } from "./JobSettings";
import { MainBlock } from "./panel/SplitView";
import { PathText } from "./PathText";

/** What a waiting clip's page needs besides the clip: the TensorRT state, the engine, the platform, the queue. */
export interface PlanContext {
  tensorrt: TrtState;
  engineKind: EngineKind | null;
  platform: string;
  queueRunning: boolean;
}

export function JobView({ job, prebuild, plan }: { job: Job; prebuild?: TrtPrebuild; plan?: PlanContext }) {
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
  const m = job.memory;
  // what ran it, from the engine's provider replies (and the app's reason when it didn't ask for TensorRT)
  const tech = job.tech ?? null;
  const ranOn = tech ? ranOnParts(tech) : null;
  const trtLine = tech ? trtJobParts(tech) : null;
  const notBuilt = tech?.fallbackReason === TRT_NOT_BUILT;
  // the steps this run goes through (the optimize step only while it happens, foundations only in low-memory mode)
  // loop: HOT-PATH-OK — ≤ seven stages per render (≤ 10/s while a job runs and the page is shown)
  const steps = STAGE_ORDER.filter((s) => (s !== "foundations" || job.memory?.lowVram) && (s !== "optimize" || job.stage === "optimize"));
  const stepAt = job.stage ? steps.indexOf(job.stage) : -1;
  // the engine's detail for the step: keying's stage-1 window ("window 4/9"), or the network an optimize builds
  const detail = job.stageDetail ? (job.stage === "keying" && job.stageDetail.startsWith("window") ? `stage 1 ${job.stageDetail}` : job.stageDetail) : null;

  return (
    <>
      {job.status === "waiting" && plan && !job.clip.probeError && <Plan job={job} plan={plan} />}

      {job.status === "running" && (
        <MainBlock title="Progress">
          {/* one progress row: the step it's on (and where that is in the run), the frames written, the step's detail */}
          <div className="progress-row">
            <div className="progress-step">
              <span className="stage now">{job.stage ? STAGE_TEXT[job.stage] : "Starting"}</span>
              {stepAt >= 0 && (
                <span className="progress-of">
                  step {stepAt + 1} of {steps.length}
                </span>
              )}
            </div>
            <ProgressBar value={job.framesDone} max={job.framesTotal ?? 0} big />
            {detail && <div className="progress-detail">{detail}</div>}
          </div>
          <div className="stats">
            <Stat k="Frames written" v={job.framesTotal ? `${job.framesDone} / ${job.framesTotal}` : String(job.framesDone)} />
            <Stat k="Speed (measured)" v={job.framesPerSecond ? `${job.framesPerSecond.toFixed(2)} fps` : "measuring…"} />
            <Stat k="Time left" v={left !== null ? `about ${duration(left)}` : "not yet"} />
            <Stat k="Elapsed" v={elapsed !== null ? duration(elapsed) : "—"} />
          </div>
          <Notes items={[["Time left", left === null ? "shown once the speed is measured, after the first frames" : null]]} />
        </MainBlock>
      )}

      {tech && (ranOn || trtLine) && (
        <MainBlock title="Technology for this run">
          <div className="stats">
            {ranOn && <Stat k="Ran on" v={ranOn.v} />}
            {trtLine && <Stat k="TensorRT" v={trtLine.v} />}
          </div>
          <Notes
            items={[
              ["Ran on", ranOn?.why ?? null],
              ["TensorRT", trtLine?.why ?? null],
            ]}
          />
          {notBuilt && (
            <p className="hint-text">
              {prebuild?.status === "running"
                ? `It builds in the background now: ${prebuildStep(prebuild.ranges) ?? "starting"}. Clips after it run on TensorRT.`
                : "Engine settings, TensorRT builds it in the background; until then clips of this size run on CUDA."}
            </p>
          )}
          {notBuilt && prebuild?.status === "running" && <ProgressBar value={Math.round(prebuild.fraction * 1000)} max={1000} />}
        </MainBlock>
      )}

      {m && (
        <MainBlock title="Memory used for this run">
          <div className="stats">
            <Stat k="Temporal window" v={`${m.hannChunk} / ${m.hannStride}`} />
            <Stat k="Low-memory mode" v={m.lowVram ? "on" : "off"} />
            <Stat k="Chosen" v={m.auto ? "automatically" : "manually"} />
            {/* the Rust engine says the free memory and the limit apart; the PyTorch engine's budget is the free memory, capped by a limit */}
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

/** The reasons behind a row of tiles, one line each under the row ("TensorRT: TensorRT is off (Engine settings)"); null reasons are left out. */
export function Notes({ items }: { items: [string, string | null][] }) {
  // loop: HOT-PATH-OK — ≤ four reasons per render
  const shown = items.filter((x): x is [string, string] => Boolean(x[1]));
  if (!shown.length) return null;
  return (
    <ul className="stat-notes">
      {/* loop: HOT-PATH-OK — as above */}
      {shown.map(([k, why]) => (
        <li key={k}>
          <span className="k">{k}:</span> {why}
        </li>
      ))}
    </ul>
  );
}

/**
 * A waiting clip: what its run will use, laid out as a run's readouts, from what the app already has (its settings,
 * the TensorRT section's logic, the engine's row-41 estimate). Nothing here is a measurement of the run itself:
 * the blocks say "will use", and what only the run decides (the automatic window) says so.
 */
function Plan({ job, plan }: { job: Job; plan: PlanContext }) {
  const o = job.options;
  const est = useEstimate(job, plan.queueRunning);
  const e = est?.ok ? est.estimate : null;
  const python = plan.engineKind === "python";
  const trt = trtPlanFor(job, plan.tensorrt, plan.engineKind);
  // where TensorRT doesn't exist (Windows, macOS): the provider the engine's estimate read the card with
  const runsOn: ValueWhy | null = trt ? { v: trt.runsOn, why: trt.text } : e?.provider ? { v: providerName(e.provider) ?? e.provider, why: null } : null;
  const deep = !python && o.deepInput;
  const input: ValueWhy = deep
    ? { v: "16-bit", why: "10/12-bit video and 16-bit PNG reach the model in full (differs from CorridorKey 2.0)" }
    : { v: "8-bit", why: python ? "the PyTorch reference engine reads as the original" : "as CorridorKey 2.0 reads it, byte for byte" };

  const m = o.memory;
  // loop: NOT-WORTH — twelve windows, once per render
  const cur = !m.auto ? (e?.windows.find((w) => w.hannChunk === m.hannChunk && w.hannStride === m.hannStride && w.lowVram === m.lowVram) ?? null) : null;
  const limit = plan.platform !== "darwin" ? o.vramLimitGb : null;
  const memoryWhy = !est
    ? "asking the engine…"
    : !est.ok
      ? est.reason
      : m.auto
        ? `the largest window that fits the free memory${limit !== null ? ` within ${limit} GiB` : ""} when the job starts${est.stale ? " (free memory read before the queue started)" : ""}`
        : estimateText(est, cur, e);

  const video = o.outputFormat === "video";
  const codec = python ? "h264-crf12" : o.videoCodec;
  const scale = python ? 1 : o.modelScale;
  const { width: cw, height: ch } = job.clip;
  // loop: NOT-WORTH — ≤ four outputs per render
  const files = o.outputs.map((x) => OUTPUT_TEXT[x].label).join(", ");

  return (
    <>
      <MainBlock title="Technology this run will use">
        <div className="stats">
          {runsOn && <Stat k="Will run on" v={runsOn.v} />}
          <Stat k="Input read" v={input.v} />
        </div>
        <Notes
          items={[
            ["TensorRT", runsOn?.why ?? null],
            ["Input", input.why],
          ]}
        />
      </MainBlock>

      <MainBlock title="Memory this run will use">
        <div className="stats">
          <Stat k="Temporal window" v={m.auto ? "when it starts" : `${m.hannChunk} / ${m.hannStride}`} />
          <Stat k="Low-memory mode" v={m.auto ? "when it starts" : m.lowVram ? "on" : "off"} />
          <Stat k="Chosen" v={m.auto ? "automatically" : "manually"} />
          {e?.freeBytes != null && <Stat k="Free now" v={gibBytes(e.freeBytes)} />}
          {plan.platform !== "darwin" && <Stat k="Graphics memory limit" v={limit !== null ? `${limit} GiB` : "Auto"} />}
          {cur && <Stat k="Runtime's peak estimate" v={gibBytes(cur.peakBytes)} />}
        </div>
        <Notes items={[[m.auto ? "Automatic" : "Estimate", memoryWhy]]} />
      </MainBlock>

      <MainBlock title="Outputs this run will write">
        <div className="stats">
          <Stat k="Files" v={files} />
          {video ? <Stat k="Video codec" v={CODEC_TEXT[codec].short} /> : <Stat k="Format" v={`EXR · ${o.exrDtype}`} />}
          <Stat k="Internal resolution" v={scale === 1 ? "Full" : `${SCALE_TEXT[scale]}${cw && ch ? ` · ${scaledSize(cw, scale)}×${scaledSize(ch, scale)}` : ""}`} />
        </div>
        <Notes items={[["Video codec", python && video ? "the PyTorch reference engine writes only this" : null]]} />
      </MainBlock>
    </>
  );
}
