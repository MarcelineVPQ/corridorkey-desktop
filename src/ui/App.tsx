import { useEffect, useState } from "react";
import { Cpu, FolderOpen, Play, Plus, Square, Trash2 } from "lucide-react";
import type { AppState, Job } from "../shared/types";
import { JobSettings } from "./JobSettings";
import { JobView } from "./JobView";
import { clipFacts, gb, statusText } from "./format";

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    void window.ck.getState().then(setState);
    const off = window.ck.onState(setState);
    // The GPU readout runs only while the window is shown (main process gates it).
    const vis = () => window.ck.setVisible(document.visibilityState === "visible");
    vis();
    document.addEventListener("visibilitychange", vis);
    return () => {
      off();
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);

  // Select the first job when nothing (or a removed job) is selected.
  useEffect(() => {
    if (!state) return;
    if (!selected || !state.jobs.some((j) => j.id === selected)) setSelected(state.jobs[0]?.id ?? null);
  }, [state, selected]);

  if (!state) return null;
  const job = state.jobs.find((j) => j.id === selected) ?? null;
  const runnable = state.jobs.some((j) => j.status === "waiting" && !j.clip.probeError);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const paths = [...e.dataTransfer.files].map((f) => window.ck.pathForFile(f)).filter(Boolean);
    if (paths.length) void window.ck.addPaths(paths);
  };

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.relatedTarget) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="topbar">
        <span className="brand">
          CorridorKey<small>2.0 · desktop</small>
        </span>
        <EngineChip state={state} />
        <GpuChip state={state} />
        <span className="spacer" />
        <button className="btn" onClick={() => window.ck.pickClips()}>
          <Plus size={16} /> Add clips
        </button>
        {state.queueRunning ? (
          <button className="btn danger" onClick={() => window.ck.stopQueue()}>
            <Square size={16} /> Stop
          </button>
        ) : (
          <button className="btn primary" disabled={!runnable || !state.checkout.ok} onClick={() => window.ck.startQueue()}>
            <Play size={16} /> Start queue
          </button>
        )}
      </header>

      <div>
        {!state.checkout.ok && (
          <section className="notice warn">
            <h3>CorridorKey isn't set up yet</h3>
            <div>The app runs CorridorKey from your CorridorKey2.0 folder (its code, weights and Python environment).</div>
            <ul>
              {state.checkout.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <button className="btn small" onClick={() => window.ck.pickCheckout()}>
              <FolderOpen size={14} /> Choose the CorridorKey2.0 folder…
            </button>
          </section>
        )}
        {state.engine.status === "failed" && (
          <section className="notice error">
            <h3>The engine didn't start</h3>
            <div>{state.engine.error}</div>
          </section>
        )}
        {state.queueRunning && state.gpu && <OtherGpuUsers state={state} />}
      </div>

      <main className="main">
        <nav className="queue" aria-label="Queue">
          {state.jobs.length === 0 ? (
            <div className="queue-empty">
              <div>Drop clips, frame folders or a folder of clips here</div>
              <button className="btn" onClick={() => window.ck.pickClips()}>
                <Plus size={16} /> Add clips
              </button>
            </div>
          ) : (
            state.jobs.map((j) => <JobRow key={j.id} job={j} selected={j.id === selected} onSelect={() => setSelected(j.id)} />)
          )}
        </nav>
        <section className="detail">{job ? <Detail job={job} /> : <div className="detail-empty">Add a clip to start.</div>}</section>
      </main>
      {dragging && <div className="drop-overlay">Drop to add to the queue</div>}
    </div>
  );
}

function JobRow({ job, selected, onSelect }: { job: Job; selected: boolean; onSelect: () => void }) {
  const pct = job.framesTotal ? (job.framesDone / job.framesTotal) * 100 : 0;
  return (
    <div className={`job-row ${selected ? "selected" : ""}`} role="button" tabIndex={0} onClick={onSelect} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}>
      {job.clip.thumb ? <img className="thumb" src={job.clip.thumb} alt="" width={96} /> : <div className="thumb" />}
      <div style={{ minWidth: 0 }}>
        <div className="job-name" title={job.clip.path}>
          {job.clip.name}
        </div>
        <div className="job-meta">{job.clip.probeError ?? clipFacts(job.clip)}</div>
        <div className={`job-status ${job.status}`}>{statusText(job)}</div>
        {job.status === "running" && (
          <div className="bar">
            <span style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      {job.status !== "running" && (
        <button
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
            Output folder: <span className="path">{job.outputDir}</span>
          </div>
          {(job.clip.companionFirstFrame || job.clip.companionHintVideo) && job.status === "waiting" && <div className="hint-text">Found a hint next to the clip and selected it.</div>}
        </div>
      </div>
      {job.clip.probeError && (
        <section className="notice error" style={{ margin: 0 }}>
          <h3>Can't read this clip</h3>
          <div>{job.clip.probeError}</div>
        </section>
      )}
      {job.status === "waiting" && !job.clip.probeError ? <JobSettings job={job} onChange={(o) => void window.ck.setJobOptions(job.id, o)} /> : <JobView job={job} />}
    </>
  );
}

function EngineChip({ state }: { state: AppState }) {
  const e = state.engine;
  const text = {
    stopped: e.pong ? `Engine ${e.pong.version} · idle (no graphics memory held)` : "Engine idle",
    starting: "Engine starting…",
    ready: `Engine ${e.pong?.version ?? ""} · ${e.pong?.engine ?? ""} · torch ${e.pong?.torch ?? ""}`,
    failed: "Engine failed",
  }[e.status];
  const cls = e.status === "ready" ? "ok" : e.status === "failed" ? "error" : e.status === "starting" ? "warn" : "";
  return (
    <span className={`chip ${cls}`}>
      <span className="dot" />
      {text}
    </span>
  );
}

function GpuChip({ state }: { state: AppState }) {
  if (state.gpuError) return <span className="chip error">GPU: {state.gpuError}</span>;
  const g = state.gpu;
  if (!g || !state.queueRunning) return null;
  return (
    <span className="chip">
      <Cpu size={13} /> {g.name.replace(/^NVIDIA (GeForce )?/, "")} · {gb(g.usedMb)} / {gb(g.totalMb)} · {g.utilization}%
    </span>
  );
}

function OtherGpuUsers({ state }: { state: AppState }) {
  const others = state.gpu!.processes.filter((p) => !p.ours && p.usedMb >= 512);
  if (others.length === 0) return null;
  return (
    <section className="notice">
      <h3>Other programs are using the graphics card</h3>
      <div className="hint-text">Automatic memory picks a smaller window when less is free. Both slow each other down while they run together.</div>
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
