// Queue: the clips (left), the selected clip's readouts (main view), its
// settings in the panel. Start/Stop and Add clips sit in the page's own bar.
import { memo } from "react";
import { ProgressBar } from "../ProgressBar";
import { FolderPlus, Play, Plus, Square, Trash2 } from "lucide-react";
import type { AppState, Job } from "../../shared/types";
import { missingInput, startBlocked } from "../../shared/tasks";
import { AS_USED, CANT_READ_CLIP } from "../../shared/texts";
import { JobSettings } from "../JobSettings";
import { JobView } from "../JobView";
import { SplitView } from "../panel/SplitView";
import { clipFacts, gib, statusText } from "../format";

export function QueuePage(props: {
  state: AppState;
  selected: string | null;
  onSelect: (id: string) => void;
  panelShown: boolean;
  narrow: boolean;
  glass: boolean;
  focus: string | null;
  sectionTasks: Record<string, string>;
  hidePanel: () => void;
}) {
  const { state, selected, onSelect } = props;
  // loop: HOT-PATH-OK — the queue's jobs per render (≤ 10/s while shown)
  const job = state.jobs.find((j) => j.id === selected) ?? null;
  const blocked = startBlocked(state);

  const main = (
    <div className="queue-page">
      <div className="page-bar">
        <h1>Queue</h1>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => window.ck.pickClips("files")}>
          <Plus size={16} /> Add clips
        </button>
        <button type="button" className="btn" onClick={() => window.ck.pickClips("folder")}>
          <FolderPlus size={16} /> Add folder
        </button>
        {state.queueRunning ? (
          <button type="button" className="btn danger" onClick={() => window.ck.stopQueue()}>
            <Square size={16} /> Stop
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={blocked !== null} title={blocked ?? undefined} onClick={() => window.ck.startQueue()}>
            <Play size={16} /> Start queue
          </button>
        )}
      </div>
      {state.queueRunning && state.gpu && <OtherGpuUsers state={state} />}
      <div className="queue-split">
        <nav className="queue" aria-label="Clips">
          {state.jobs.length === 0 ? (
            <div className="queue-empty">
              <div>Drop clips, frame folders or a folder of clips here</div>
              <div className="btn-row">
                <button type="button" className="btn" onClick={() => window.ck.pickClips("files")}>
                  <Plus size={16} /> Add clips
                </button>
                <button type="button" className="btn" onClick={() => window.ck.pickClips("folder")}>
                  <FolderPlus size={16} /> Add folder
                </button>
              </div>
            </div>
          ) : (
            // loop: HOT-PATH-OK — one row per job per render (≤ 10/s while shown; rows are cheap, measured pushes ~2/s during a job)
            state.jobs.map((j) => <JobRow key={j.id} job={j} selected={j.id === selected} onSelect={() => onSelect(j.id)} />)
          )}
        </nav>
        <section className="detail">{job ? <Detail job={job} /> : <div className="detail-empty">Add a clip to start.</div>}</section>
      </div>
    </div>
  );

  return (
    <SplitView
      main={main}
      panel={
        job ? (
          <JobSettings
            job={job}
            focus={props.focus}
            sectionTasks={props.sectionTasks}
            queueRunning={state.queueRunning}
            platform={state.system.platform}
            engineKind={state.engineKind}
            onChange={(o) => void window.ck.setJobOptions(job.id, o)}
          />
        ) : (
          <p className="hint-text">Select a clip to see its settings.</p>
        )
      }
      panelTitle={job ? job.clip.name : "Clip settings"}
      panelSub={job ? (job.status === "waiting" ? "Settings for this clip" : AS_USED) : undefined}
      shown={props.panelShown}
      narrow={props.narrow}
      glass={props.glass}
      onEscape={props.hidePanel}
    />
  );
}

/**
 * One queue row. Memoised: every state push brings fresh job objects over IPC, so without it every row of a long queue
 * re-rendered on every push; a row now renders again only when what it shows changed (leak audit 2026-10-24, #5).
 */
const JobRow = memo(JobRowView, (a, b) => a.selected === b.selected && rowKey(a.job) === rowKey(b.job));

/** What a row shows, as one string: the job without its log and stills (the row never shows those). */
// loop: NOT-WORTH — serialises one job's row fields, per row per state push (no log, no stills)
const rowKey = (j: Job) => JSON.stringify({ ...j, log: undefined, logLines: undefined, stills: undefined });

function JobRowView({ job, selected, onSelect }: { job: Job; selected: boolean; onSelect: () => void }) {
  const need = missingInput(job);
  return (
    <div
      className={`job-row ${selected ? "selected" : ""}`}
      role="button"
      tabIndex={0}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}
    >
      <span className="thumb-wrap">
        {job.clip.thumb ? <img className="thumb" src={job.clip.thumb} alt="" width={96} loading="lazy" decoding="async" /> : <div className="thumb" />}
        {need && <i className="task" aria-hidden />}
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="job-name" title={job.clip.path}>
          {job.clip.name}
        </div>
        <div className="job-meta">{job.clip.probeError ?? clipFacts(job.clip)}</div>
        <div className={`job-status ${job.status}`}>{need ? `Waiting: ${need}` : statusText(job)}</div>
        {job.status === "running" && <ProgressBar value={job.framesDone} max={job.framesTotal ?? 0} />}
      </div>
      {job.status !== "running" && (
        <button
          type="button"
          className="icon-btn"
          aria-label={`Remove ${job.clip.name}`}
          title="Remove from the queue"
          onClick={(e) => {
            e.stopPropagation();
            void window.ck.removeJob(job.id);
          }}
        >
          <Trash2 size={15} />
        </button>
      )}
    </div>
  );
}

function Detail({ job }: { job: Job }) {
  return (
    <>
      <div className="detail-head">
        {job.clip.thumb ? <img className="thumb" src={job.clip.thumb} alt="" width={240} /> : <div className="thumb" />}
        <div style={{ minWidth: 0 }}>
          <h2>{job.clip.name}</h2>
          <div className="job-meta">{clipFacts(job.clip)}</div>
          <div className="path">{job.clip.path}</div>
          <div className="hint-text" style={{ marginTop: 8 }}>
            Results: <span className="path">{job.outputDir}</span>
          </div>
          {(job.clip.companionFirstFrame || job.clip.companionHintVideo) && job.status === "waiting" && <div className="hint-text">Found a hint next to the clip and selected it.</div>}
        </div>
      </div>
      {job.clip.probeError && (
        <section className="notice error">
          <h3>{CANT_READ_CLIP}</h3>
          <div>{job.clip.probeError}</div>
        </section>
      )}
      <JobView job={job} />
    </>
  );
}

/** Another program holding this much graphics memory is named before a run (desktops and browsers hold less;
 * the engine bench refuses to start above 1 GiB, tools/engine_bench.mjs). */
const OTHER_GPU_USER_MB = 512;

function OtherGpuUsers({ state }: { state: AppState }) {
  // loop: HOT-PATH-OK — a few compute processes per render
  const others = state.gpu!.processes.filter((p) => !p.ours && p.usedMb >= OTHER_GPU_USER_MB);
  if (others.length === 0) return null;
  return (
    <section className="notice" style={{ margin: "0 16px 12px" }}>
      <h3>Other programs are using the graphics card</h3>
      <div className="hint-text">Automatic memory picks a smaller window when less is free; both run slower together.</div>
      <ul className="gpu-procs">
        {/* loop: HOT-PATH-OK — a few compute processes per render */}
        {others.map((p) => (
          <li key={p.pid}>
            {p.name} — {gib(p.usedMb)}
          </li>
        ))}
      </ul>
    </section>
  );
}
