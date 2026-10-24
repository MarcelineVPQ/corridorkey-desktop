// The first-run install and the ffmpeg check as one control each, shared by the setup page
// (pages/SetupPage.tsx) and the Engine page's panel, so the two never drift apart.
import { Check, Download, X } from "lucide-react";
import type { FfmpegState, InstallState } from "../../shared/types";
import { installMissing } from "../../shared/tasks";
import { Row } from "../panel/Section";
import { gbBytes } from "../format";

export const installPct = (inst: InstallState) => (inst.total ? Math.floor((inst.done / inst.total) * 100) : 0);

/** The GPU runtime and the models: what downloads, the button, real progress, Stop, the error. */
export function InstallBox({ inst }: { inst: InstallState }) {
  const needInstall = installMissing(inst);
  const pct = installPct(inst);
  if (!needInstall)
    return (
      <div className="check-line ok">
        <Check size={15} aria-hidden /> The GPU runtime and the CorridorKey models are installed
      </div>
    );
  return (
    <>
      <p className="hint-text">CorridorKey downloads what it runs on, once, into {inst.dir}:</p>
      <ul className="check-list">
        {inst.needRuntime && (
          <li className="hint-text">
            GPU runtime, {gbBytes(inst.runtimeBytes)} download: {inst.runtimeWhat}
          </li>
        )}
        {inst.needModels && (
          <li className="hint-text">
            CorridorKey models, {gbBytes(inst.modelsBytes)} download: by Corridor Digital, under the CorridorKey licence (free to use, never sold), from this app's GitHub releases
          </li>
        )}
      </ul>
      {inst.gpuProblem && <p className="hint-text">{inst.gpuProblem}</p>}
      {inst.status === "running" ? (
        <>
          <div className="hint-text">
            {inst.step} · {gbBytes(inst.done)} of {gbBytes(inst.total)}
          </div>
          <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={inst.total} aria-valuenow={inst.done}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <button type="button" className="btn small" onClick={() => void window.ck.stopInstall()}>
            Stop
          </button>
        </>
      ) : (
        <button type="button" className="btn small primary" disabled={!inst.gpuOk} onClick={() => void window.ck.startInstall()}>
          <Download size={14} /> {inst.error ? "Try again (resumes)" : `Download and install (${gbBytes(inst.bytes)})`}
        </button>
      )}
      {inst.error && (
        <div className="check-line error">
          <X size={15} aria-hidden /> {inst.error}
        </div>
      )}
      <p className="hint-text">Every file is checked against its SHA-256 before it is used. A stopped download continues where it left off.</p>
    </>
  );
}

/** ffmpeg: checking, found, or what's missing with the install command (and the button where the app can run it). */
export function FfmpegBox({ ff }: { ff: FfmpegState }) {
  if (!ff.checked) return <p className="hint-text">Checking ffmpeg…</p>;
  if (ff.ok)
    return (
      <div className="check-line ok">
        <Check size={15} aria-hidden /> ffmpeg and ffprobe found, with the H.264 and ProRes 4444 encoders
      </div>
    );
  return (
    <>
      <p className="hint-text">CorridorKey reads and writes video with ffmpeg. {ff.problem}.</p>
      {ff.note && <p className="hint-text">{ff.note}</p>}
      <Row label="Install command" hint={!ff.canInstall ? "Run it in a terminal" : ff.runHint}>
        <div className="path selectable">{ff.command}</div>
      </Row>
      {ff.canInstall && (
        <button type="button" className="btn small primary" disabled={ff.installing} onClick={() => void window.ck.installFfmpeg()}>
          {ff.installing ? "Installing…" : "Install ffmpeg"}
        </button>
      )}
      {ff.installError && (
        <div className="check-line error">
          <X size={15} aria-hidden /> {ff.installError}
        </div>
      )}
    </>
  );
}
