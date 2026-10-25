// The first-run install and the ffmpeg check as one control each, shared by the setup page
// (pages/SetupPage.tsx) and the Engine page's panel, so the two never drift apart.
import { Check, Download, X } from "lucide-react";
import type { FfmpegState, InstallState, TrtState } from "../../shared/types";
import { installMissing } from "../../shared/tasks";
import { INSTALL_FIRST } from "../../shared/texts";
import { Row } from "../panel/Section";
import { gbBytes } from "../format";
import { ProgressBar } from "../ProgressBar";

export const installPct = (inst: Pick<InstallState, "done" | "total">) => (inst.total ? Math.floor((inst.done / inst.total) * 100) : 0);

/** The GPU runtime and the models: what downloads, the button, real progress, Stop, the error. */
export function InstallBox({ inst }: { inst: InstallState }) {
  const needInstall = installMissing(inst);
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
      <InstallControls p={inst} canStart={inst.gpuOk} start={() => void window.ck.startInstall()} />
    </>
  );
}

/** One install's controls (the runtime and models, or TensorRT's parts): the button, real progress, Stop, the error. */
function InstallControls({ p, canStart, start }: { p: Pick<InstallState, "status" | "step" | "done" | "total" | "error" | "bytes">; canStart: boolean; start: () => void }) {
  return (
    <>
      {p.status === "running" ? (
        <>
          <div className="hint-text">
            {p.step} · {gbBytes(p.done)} of {gbBytes(p.total)}
          </div>
          <ProgressBar value={p.done} max={p.total} />
          <button type="button" className="btn small" onClick={() => void window.ck.stopInstall()}>
            Stop
          </button>
        </>
      ) : (
        <button type="button" className="btn small primary" disabled={!canStart} onClick={start}>
          <Download size={14} /> {p.error ? "Try again (resumes)" : `Download and install (${gbBytes(p.bytes)})`}
        </button>
      )}
      {p.error && (
        <div className="check-line error">
          <X size={15} aria-hidden /> {p.error}
        </div>
      )}
      <p className="hint-text">Every file is checked against its SHA-256 before it is used. A stopped download continues where it left off.</p>
    </>
  );
}

/**
 * The TensorRT setting (Engine settings): the switch, what it means, and the install box for its parts once it is
 * on. Linux only in 1.0: elsewhere the section says why there is no switch (no control that does nothing).
 */
export function TrtBox({ trt, inst, platform }: { trt: TrtState; inst: InstallState; platform: string }) {
  if (!trt.supported)
    return (
      <p className="hint-text">
        {platform === "darwin"
          ? "TensorRT is NVIDIA's, and Macs have no NVIDIA graphics: CorridorKey runs on Apple's GPU and Neural Engine through Core ML instead."
          : "TensorRT (faster on NVIDIA cards) is Linux-only in this version: on Windows it needs its own engine builder, which comes in a later version. Jobs run on CUDA."}
      </p>
    );
  const baseMissing = installMissing(inst);
  const needParts = trt.needLibs || trt.needProvider || trt.needModels;
  return (
    <>
      <Row label="Use TensorRT (faster on NVIDIA)" htmlFor="tensorrt-on">
        <label className="checks">
          <input id="tensorrt-on" type="checkbox" checked={trt.on} onChange={(e) => void window.ck.setTensorrt(e.target.checked)} />
          On
        </label>
      </Row>
      <p className="hint-text">
        About 2× the original&apos;s speed at HD, with the same mattes (README, Speed, 0.0.6-dev). The first job at each resolution optimizes for it once, about 4.5 minutes on an RTX 5080 (about 5 at
        4K); later jobs reuse that. Best on graphics cards with 16 GB. 4K (DCI 4K and UHD) runs on TensorRT too; open gate and larger frames run on CUDA. An extra {gbBytes(trt.fullBytes)} download:
        NVIDIA&apos;s TensorRT libraries and the TensorRT models.
      </p>
      {trt.on &&
        (baseMissing ? (
          <p className="hint-text">{INSTALL_FIRST} (Runtime and models, above).</p>
        ) : needParts || trt.status !== "idle" ? (
          <>
            <ul className="check-list">
              {trt.needLibs && <li className="hint-text">NVIDIA TensorRT 10.16 libraries (NVIDIA licence), from pypi.nvidia.com</li>}
              {trt.needProvider && <li className="hint-text">ONNX Runtime&apos;s TensorRT part, from pypi.org (a runtime installed before 1.0 lacks it)</li>}
              {trt.needModels && <li className="hint-text">The TensorRT models: the same CorridorKey networks, prepared for TensorRT, from this app&apos;s GitHub releases</li>}
            </ul>
            <p className="hint-text">Until they are installed, jobs run on CUDA.</p>
            <InstallControls p={trt} canStart={inst.gpuOk && inst.status !== "running"} start={() => void window.ck.startInstall("tensorrt")} />
          </>
        ) : trt.ready ? (
          <div className="check-line ok">
            <Check size={15} aria-hidden /> Installed: jobs run on TensorRT
          </div>
        ) : (
          <p className="hint-text">Installed for the downloaded runtime and models, but the engine uses other files (ONNX Runtime engine, below), so jobs run on CUDA.</p>
        ))}
      {!trt.on && !needParts && <p className="hint-text">Installed. App settings, Storage removes it.</p>}
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
