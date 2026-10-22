// Queue: the clips (left), the selected clip's readouts (main view), its
// settings in the panel. Start/Stop and Add clips sit in the page's own bar.
import { Play, Plus, Square, Trash2 } from "lucide-react";
import type { AppState, Job } from "../../shared/types";
import { missingInput } from "../../shared/tasks";
import { JobSettings } from "../JobSettings";
import { JobView } from "../JobView";
import { SplitView } from "../panel/SplitView";
import { clipFacts, gb, statusText } from "../format";

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
  const job = state.jobs.find((j) => j.id === selected) ?? null;
  const runnable = state.jobs.some((j) => j.status === "waiting" && !j.clip.probeError && !missingInput(j));

  const main = (
    <div className="queue-page">
      <div className="page-bar">
        <h1>Queue</h1>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => window.ck.pickClips()}>
          <Plus size={16} /> Add clips
        </button>
        {state.queueRunning ? (
          <button type="button" className="btn danger" onClick={() => window.ck.stopQueue()}>
            <Square size={16} /> Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn primary"
            disabled={!runnable || !state.engineKind}
            title={!state.engineKind ? "Set up the engine first (Engine page)" : !runnable ? "Add a clip that's ready to run" : undefined}
            onClick={() => window.ck.startQueue()}
          >
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
              <button type="button" className="btn" onClick={() => window.ck.pickClips()}>
                <Plus size={16} /> Add clips
              </button>
            </div>
          ) : (
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
          <JobSettings job={job} focus={props.focus} sectionTasks={props.sectionTasks} onChange={(o) => void window.ck.setJobOptions(job.id, o)} />
        ) : (
          <p className="hint-text">Select a clip to see its settings.</p>
        )
      }
      panelTitle={job ? job.clip.name : "Clip settings"}
      panelSub={job ? (job.status === "waiting" ? "Settings for this clip" : "As used for this run") : undefined}
      shown={props.panelShown}
      narrow={props.narrow}
      glass={props.glass}
      onEscape={props.hidePanel}
    />
  );
}

function JobRow({ job, selected, onSelect }: { job: Job; selected: boolean; onSelect: () => void }) {
  const pct = job.framesTotal ? (job.framesDone / job.framesTotal) * 100 : 0;
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
        {job.clip.thumb ? <img className="thumb" src={job.clip.thumb} alt="" width={96} /> : <div className="thumb" />}
        {need && <i className="task" aria-hidden />}
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="job-name" title={job.clip.path}>
          {job.clip.name}
        </div>
        <div className="job-meta">{job.clip.probeError ?? clipFacts(job.clip)}</div>
        <div className={`job-status ${job.status}`}>{need ? `Waiting: ${need}` : statusText(job)}</div>
        {job.status === "running" && (
          <div className="bar">
            <span style={{ width: `${pct}%` }} />
          </div>
        )}
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
        <section className="notice error" style={{ margin: "0 0 14px" }}>
          <h3>Can't read this clip</h3>
          <div>{job.clip.probeError}</div>
        </section>
      )}
      <JobView job={job} />
    </>
  );
}

function OtherGpuUsers({ state }: { state: AppState }) {
  const others = state.gpu!.processes.filter((p) => !p.ours && p.usedMb >= 512);
  if (others.length === 0) return null;
  return (
    <section className="notice" style={{ margin: "0 16px 12px" }}>
      <h3>Other programs are using the graphics card</h3>
      <div className="hint-text">Automatic memory picks a smaller window when less is free; both run slower together.</div>
      <ul className="gpu-procs">
        {others.map((p) => (
          <li key={p.pid}>
            {p.name} — {gb(p.usedMb)}
          </li>
        ))}
      </ul>
    </section>
  );
}
