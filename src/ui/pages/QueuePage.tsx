// Queue: the clips (left), the selected clip's readouts (main view), its
// settings in the panel. Start/Stop and Add clips sit in the page's own bar.
import { memo, useEffect, useState } from "react";
import { ProgressBar } from "../ProgressBar";
import { Check, ClipboardCopy, FolderPlus, Play, Plus, Square, SquareTerminal, Trash2 } from "lucide-react";
import { jobCommand } from "../../shared/console/jobCommand";
import { OTHER_GPU_USER_MB, type AppState, type Job, type TrtPrebuild } from "../../shared/types";
import { missingInput, startBlocked } from "../../shared/tasks";
import { AS_USED, CANT_READ_CLIP } from "../../shared/texts";
import { JobSettings } from "../JobSettings";
import { JobView } from "../JobView";
import type { SectionFocus } from "../panel/Section";
import { SplitView } from "../panel/SplitView";
import { PathText } from "../PathText";
import { clipFacts, gib, statusText } from "../format";

export function QueuePage(props: {
  state: AppState;
  selected: string | null;
  onSelect: (id: string) => void;
  panelShown: boolean;
  narrow: boolean;
  glass: boolean;
  focus: SectionFocus;
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
          <button type="button" className="btn primary" disabled={blocked !== null} aria-describedby={blocked ? "start-blocked" : undefined} onClick={() => window.ck.startQueue()}>
            <Play size={16} /> Start queue
          </button>
        )}
      </div>
      {/* why Start queue is off, said on screen (not only as a tooltip) */}
      {!state.queueRunning && blocked && (
        <p id="start-blocked" className="hint-text bar-note">
          Start queue: {blocked}
        </p>
      )}
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
        <section className="detail">
          {job ? <Detail job={job} prebuild={state.tensorrt.prebuild} windows={state.system.platform === "win32"} /> : <div className="detail-empty">Add a clip to start.</div>}
        </section>
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
            tensorrt={state.tensorrt}
            onChange={(o) => window.ck.setJobOptions(job.id, o)}
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
    // the whole row takes a click; the keyboard and screen readers get the clip's name as the button (a row as a
    // button can't hold the Remove button)
    <div className={`job-row ${selected ? "selected" : ""}`} onClick={onSelect}>
      <span className="thumb-wrap">
        {job.clip.thumb ? <img className="thumb" src={job.clip.thumb} alt="" width={96} loading="lazy" decoding="async" /> : <div className="thumb" />}
        {need && <i className="task" aria-hidden />}
      </span>
      <div>
        <button type="button" className="job-name" title={job.clip.path} aria-current={selected ? "true" : undefined}>
          {job.clip.name}
        </button>
        <div className="job-meta">{job.clip.probeError ?? clipFacts(job.clip)}</div>
        <div className={`job-status ${job.status}`}>{need ? `Waiting: ${need}` : statusText(job)}</div>
        {job.status === "running" && <ProgressBar label={`${job.clip.name}: frames written`} value={job.framesDone} max={job.framesTotal ?? 0} />}
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

function Detail({ job, prebuild, windows }: { job: Job; prebuild: TrtPrebuild; windows: boolean }) {
  return (
    <>
      <div className="detail-head">
        {job.clip.thumb ? <img className="thumb" src={job.clip.thumb} alt="" width={240} /> : <div className="thumb" />}
        <div>
          <h2>{job.clip.name}</h2>
          <div className="job-meta">{clipFacts(job.clip)}</div>
          <div>
            <PathText path={job.clip.path} />
          </div>
          <div className="hint-text gap-top">
            Results: <PathText path={job.outputDir} />
          </div>
          {job.status !== "waiting" && <LogLine job={job} />}
          <CopyCommand job={job} windows={windows} />
          {(job.clip.companionFirstFrame || job.clip.companionHintVideo) && job.status === "waiting" && <div className="hint-text">Found a hint next to the clip and selected it.</div>}
        </div>
      </div>
      {job.clip.probeError && (
        <section className="notice error">
          <h3>{CANT_READ_CLIP}</h3>
          <div>{job.clip.probeError}</div>
        </section>
      )}
      <JobView job={job} prebuild={prebuild} />
    </>
  );
}

/** How long Copy log says "Copied". */
const COPIED_MS = 1500;

/**
 * The job's engine log (backlog row 55): Copy log puts the whole log on the clipboard (the main process builds it, as
 * the saved file has it: the page holds only the last lines), and the line names the <clip>_log.txt written when the
 * job ended, or why it couldn't be.
 */
function LogLine({ job }: { job: Job }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    // lifetime: OK — one timer per copy, cleared on unmount or the next copy
    // loop: NOT-WORTH — one 1.5 s timer per Copy log press
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  const saved = job.logSaved ?? null;
  return (
    <>
      <div className="hint-text">
        {saved ? (
          saved.error ? (
            `The log couldn't be saved: ${saved.error}`
          ) : (
            <>
              Log: <PathText path={saved.path} />
            </>
          )
        ) : (
          "The log is saved next to the results when the job ends."
        )}
      </div>
      <div className="gap-top">
        <button type="button" className="btn small" onClick={() => void window.ck.copyJobLog(job.id).then(setCopied)}>
          {copied ? <Check size={14} aria-hidden /> : <ClipboardCopy size={14} aria-hidden />}
          <span aria-live="polite">{copied ? "Copied" : "Copy log"}</span>
        </button>
      </div>
    </>
  );
}

/**
 * Copy as command (teach by echo): the job as its corridorkey render line, for the Console, a terminal or a farm (quoted
 * so a shell runs nothing in it: jobCommand). Once it has started, the line it ran as (TensorRT as the queue asked);
 * before, its settings (TensorRT is chosen when it starts).
 */
function CopyCommand({ job, windows }: { job: Job; windows: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    // lifetime: OK — one timer per copy, cleared on unmount or the next copy
    // loop: NOT-WORTH — one 1.5 s timer per Copy press
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  const r = job.command ? { line: job.command } : jobCommand(job, false, windows);
  // no safe line (a path a shell would read part of): said instead of a button that copies nothing
  if ("error" in r) return <div className="hint-text gap-top">Copy as command: {r.error}.</div>;
  const line = r.line;
  return (
    <div className="gap-top">
      <button type="button" className="btn small" title={line} onClick={() => void window.ck.copyText(line).then(setCopied)}>
        {copied ? <Check size={14} aria-hidden /> : <SquareTerminal size={14} aria-hidden />}
        <span aria-live="polite">{copied ? "Copied" : "Copy as command"}</span>
      </button>
    </div>
  );
}

function OtherGpuUsers({ state }: { state: AppState }) {
  // loop: HOT-PATH-OK — a few compute processes per render
  const others = state.gpu!.processes.filter((p) => !p.ours && p.usedMb >= OTHER_GPU_USER_MB);
  if (others.length === 0) return null;
  return (
    <section className="notice inset">
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
