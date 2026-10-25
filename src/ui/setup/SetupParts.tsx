// The first-run install and the ffmpeg check as one control each, shared by the setup page
// (pages/SetupPage.tsx) and the Engine page's panel, so the two never drift apart.
import { Check, Download, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { FfmpegState, InstallState, TrtState } from "../../shared/types";
import { installMissing } from "../../shared/tasks";
import { INSTALL_FIRST } from "../../shared/texts";
import { Row } from "../panel/Section";
import { duration, gbBytes } from "../format";
import { PIECE_NAMES, prebuildStep, rangeText, trtSizeKey, TRT_BUILD_NOT_MEASURED, TRT_NOT_MEASURED } from "../../shared/trt";
import { ProgressBar } from "../ProgressBar";
import { More } from "../More";
import { PathText } from "../PathText";

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
  // loop: NOT-WORTH — two parts per render
  const what = [inst.needRuntime && `GPU runtime, ${gbBytes(inst.runtimeBytes)}`, inst.needModels && `CorridorKey models, ${gbBytes(inst.modelsBytes)}`].filter(Boolean).join(" · ");
  return (
    <>
      <p className="hint-text">
        {what}: downloaded once, into <PathText path={inst.dir} />
      </p>
      <More>
        <ul className="check-list">
          {inst.needRuntime && <li className="hint-text">GPU runtime: {inst.runtimeWhat}</li>}
          {inst.needModels && <li className="hint-text">CorridorKey models: by Corridor Digital, under the CorridorKey licence (free to use, never sold), from this app&apos;s GitHub releases</li>}
        </ul>
        <p className="hint-text">{CHECKED_AND_RESUMED}</p>
      </More>
      {inst.gpuProblem && <p className="hint-text">{inst.gpuProblem}</p>}
      <InstallControls p={inst} canStart={inst.gpuOk} start={() => void window.ck.startInstall()} />
    </>
  );
}

const CHECKED_AND_RESUMED = "Every file is checked against its SHA-256 before it is used. A stopped download continues where it left off.";

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
          : "TensorRT (NVIDIA's optimizer for its graphics cards) is Linux-only in this version: on Windows it needs its own engine builder, which comes in a later version. Jobs run on CUDA."}
      </p>
    );
  const baseMissing = installMissing(inst);
  const needParts = trt.needLibs || trt.needProvider || trt.needModels;
  return (
    <>
      <Row label="Use TensorRT (NVIDIA)" htmlFor="tensorrt-on">
        <label className="checks">
          <input id="tensorrt-on" type="checkbox" checked={trt.on} onChange={(e) => void window.ck.setTensorrt(e.target.checked)} />
          On
        </label>
      </Row>
      <p className="hint-text">
        Optimizes the CorridorKey networks for this graphics card, once per resolution range. An extra {gbBytes(trt.fullBytes)} download. {TRT_NOT_MEASURED}
      </p>
      <More>
        <p className="hint-text">
          The download is NVIDIA&apos;s TensorRT libraries and the TensorRT models. The app builds 4K and HD in the background; jobs never wait on a build. Best on graphics cards with 16 GB. 4K (DCI
          4K and UHD) runs on TensorRT too; open gate and larger frames run on CUDA.
        </p>
        <p className="hint-text">{CHECKED_AND_RESUMED}</p>
      </More>
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
          <>
            <div className="check-line ok">
              <Check size={15} aria-hidden /> Installed
            </div>
            <PrebuildBox trt={trt} />
          </>
        ) : (
          <p className="hint-text">Installed for the downloaded runtime and models, but the engine uses other files (ONNX Runtime engine, below), so jobs run on CUDA.</p>
        ))}
      {!trt.on && !needParts && <p className="hint-text">Installed. App settings, Storage removes it.</p>}
    </>
  );
}

/**
 * The background TensorRT build (electron/main/trtPrebuild.ts): what it is and why, the ranges built, a progress bar
 * by network (weighted by the measured 4K build times; HD one share per network), the step, the elapsed time, and
 * Stop / Build now. Jobs never build: until a range is built, its clips run on CUDA.
 */
function PrebuildBox({ trt }: { trt: TrtState }) {
  const p = trt.prebuild;
  // a 1 s tick for the elapsed clock, only while the build runs and the page is visible (rule 3)
  const [, tick] = useState(0);
  useEffect(() => {
    if (p.status !== "running") return;
    // lifetime: OK — cleared when the build stops or the box unmounts
    // loop: HOT-PATH-OK — one re-render per second while the background build runs and the page is visible
    const t = setInterval(() => document.visibilityState === "visible" && tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [p.status]);
  const step = prebuildStep(p.ranges);
  const canStart = p.status !== "running" && p.status !== "done";
  return (
    <>
      <p className="hint-text">The app builds 4K and HD in the background and pauses while you key. Until a size is built, its clips run on CUDA.</p>
      <More>
        <p className="hint-text">Jobs never wait on a TensorRT build. It builds again only after a graphics driver, TensorRT or model update. {TRT_BUILD_NOT_MEASURED}</p>
      </More>
      <ul className="check-list">
        {/* loop: HOT-PATH-OK — two ranges per render */}
        {p.ranges.map((r) => (
          <li key={r.label} className="hint-text">
            {r.label} ({r.width}×{r.height}):{" "}
            {r.state === "done"
              ? `built${r.range ? `, ${rangeText(r.range)}` : ""}${
                  Object.keys(r.fallbacks).length
                    ? ` (${Object.keys(r.fallbacks)
                        .map((k) => PIECE_NAMES[k] ?? k)
                        .join(", ")} on CUDA)`
                    : ""
                }`
              : r.state === "building"
                ? "building"
                : r.state === "failed"
                  ? `couldn't be built: ${r.error}`
                  : "not built yet"}
          </li>
        ))}
        {/* loop: HOT-PATH-OK — a few built ranges per render */}
        {trt.built
          .filter((k) => !p.ranges.some((r) => r.range === k || k.startsWith(`${trtSizeKey(r.width, r.height)}_t`)))
          .map((k) => (
            <li key={k} className="hint-text">
              Also built: {rangeText(k)}
            </li>
          ))}
      </ul>
      {p.status === "running" && (
        <>
          <ProgressBar value={Math.round(p.fraction * 1000)} max={1000} />
          <p className="hint-text">
            {step ?? "Starting the engine"} · {Math.floor(p.fraction * 100)} % of 4K and HD · {p.startedAt ? `${duration((Date.now() - p.startedAt) / 1000)} elapsed` : ""}
          </p>
        </>
      )}
      {p.status === "paused" && <p className="hint-text">Paused while the queue runs; it goes on by itself when the queue stops.</p>}
      {p.status === "blocked" && <p className="hint-text">Not started: {p.note}. It doesn&apos;t take the card from another program by itself; Build now starts it anyway.</p>}
      {p.status === "stopped" && <p className="hint-text">Stopped. What was built is kept; Build now goes on from there.</p>}
      {p.status === "error" && <p className="notice error">The background build stopped: {p.note}</p>}
      <div className="file-pick">
        {p.status === "running" && (
          <button type="button" className="btn small" onClick={() => void window.ck.trtPrebuild("stop")}>
            <X size={14} /> Stop
          </button>
        )}
        {canStart && p.status !== "paused" && (
          <button type="button" className="btn small" onClick={() => void window.ck.trtPrebuild("start")}>
            <Download size={14} /> Build now
          </button>
        )}
      </div>
    </>
  );
}

/** ffmpeg: checking, found, or what's missing with the install command (and the button where the app can run it). */
export function FfmpegBox({ ff }: { ff: FfmpegState }) {
  if (!ff.checked) return <p className="hint-text">Checking ffmpeg…</p>;
  if (ff.ok)
    return (
      <div className="check-line ok">
        <Check size={15} aria-hidden /> ffmpeg and ffprobe found, with the encoders the video outputs need (10-bit H.264)
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
