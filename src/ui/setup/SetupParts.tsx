// The first-run install and the ffmpeg check as one control each, shared by the setup page
// (pages/SetupPage.tsx) and the Engine page's panel, so the two never drift apart.
import { Check, Download, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { FfmpegState, InstallState, TrtState } from "../../shared/types";
import { installMissing } from "../../shared/tasks";
import { AMD_UNTESTED, INSTALL_FIRST } from "../../shared/texts";
import { Row } from "../panel/Section";
import { duration, gbBytes } from "../format";
import {
  PIECE_NAMES,
  buildSteps,
  prebuildStep,
  rangeText,
  sizeRangeText,
  sizeText,
  trtSizeKey,
  trtSizeRows,
  TRT_BUILD_COST,
  TRT_BUILD_TEXT,
  TRT_MAX_SIDE,
  TRT_SPEED,
  TRT_PIECES,
  ownTrtSize,
  type TrtSize,
} from "../../shared/trt";
import { ProgressBar } from "../ProgressBar";
import { More } from "../More";
import { PathText } from "../PathText";

// the repository's issues (updateFeed.ts REPO); the link opens in the browser (index.ts setWindowOpenHandler)
const ISSUES = "https://github.com/MarcelineVPQ/corridorkey-desktop/issues";

/** AMD cards are on by default and untested on a real one: said wherever an AMD user meets them (backlog row 166). */
export function AmdUntested() {
  return (
    <p className="hint-text">
      {AMD_UNTESTED} on{" "}
      <a href={ISSUES} target="_blank" rel="noreferrer">
        GitHub issues
      </a>
      .
    </p>
  );
}

export const installPct = (inst: Pick<InstallState, "done" | "total">) => (inst.total ? Math.floor((inst.done / inst.total) * 100) : 0);

/** The GPU runtime and the models: what downloads, the button, real progress, Stop, the error. */
export function InstallBox({ inst }: { inst: InstallState }) {
  const needInstall = installMissing(inst);
  if (!needInstall)
    return (
      <>
        <div className="check-line ok">
          <Check size={15} aria-hidden /> The GPU runtime and the CorridorKey models are installed
        </div>
        {inst.amd && <AmdUntested />}
      </>
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
      {inst.amd && <AmdUntested />}
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
          <ProgressBar label="Downloaded" value={p.done} max={p.total} />
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
      <>
        <p className="hint-text">
          {platform === "darwin"
            ? "TensorRT is NVIDIA's, and Macs have no NVIDIA graphics: CorridorKey runs on Apple's GPU and Neural Engine through Core ML instead."
            : platform === "linux"
              ? "TensorRT is NVIDIA's: on this AMD graphics card CorridorKey runs through AMD's MIGraphX instead."
              : "TensorRT (NVIDIA's optimizer for its graphics cards) is Linux-only in this version: on Windows it needs its own engine builder, which comes in a later version. Jobs run on CUDA."}
        </p>
        {inst.amd && <AmdUntested />}
      </>
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
        Optimizes the CorridorKey networks for this graphics card, once per resolution range. An extra {gbBytes(trt.fullBytes)} download. {TRT_SPEED}
      </p>
      <More>
        <p className="hint-text">
          The download is NVIDIA&apos;s TensorRT libraries and the TensorRT models. The app builds the sizes you choose (4K DCI and HD to start with) in the background; jobs never wait on a build.
          Best on graphics cards with 16 GB. 4K (DCI 4K and UHD) runs on TensorRT too; open gate and larger frames run on CUDA.
        </p>
        <p className="hint-text">{CHECKED_AND_RESUMED}</p>
      </More>
      {trt.on &&
        (baseMissing ? (
          <>
            <p className="hint-text">{INSTALL_FIRST} (Runtime and models, above).</p>
            <TrtSizes trt={trt} />
          </>
        ) : needParts || trt.status !== "idle" ? (
          <>
            <ul className="check-list">
              {trt.needLibs && <li className="hint-text">NVIDIA TensorRT 10.16 libraries (NVIDIA licence), from pypi.nvidia.com</li>}
              {trt.needProvider && <li className="hint-text">ONNX Runtime&apos;s TensorRT part, from pypi.org (a runtime installed before 1.0 lacks it)</li>}
              {trt.needModels && <li className="hint-text">The TensorRT models: the same CorridorKey networks, prepared for TensorRT, from this app&apos;s GitHub releases</li>}
            </ul>
            <p className="hint-text">Until they are installed, jobs run on CUDA.</p>
            <InstallControls p={trt} canStart={inst.gpuOk && inst.status !== "running"} start={() => void window.ck.startInstall("tensorrt")} />
            <TrtSizes trt={trt} />
          </>
        ) : trt.ready ? (
          <>
            <div className="check-line ok">
              <Check size={15} aria-hidden /> Installed
            </div>
            <PrebuildBox trt={trt} />
          </>
        ) : (
          <>
            <p className="hint-text">Installed for the downloaded runtime and models, but the engine uses other files (ONNX Runtime engine, below), so jobs run on CUDA.</p>
            <TrtSizes trt={trt} />
          </>
        ))}
      {!trt.on && !needParts && <p className="hint-text">Installed. App settings, Storage removes it.</p>}
    </>
  );
}

/**
 * The background TensorRT build (electron/main/trtPrebuild.ts): what it is and why, the sizes to build (TrtSizes), a
 * progress bar by network (weighted by the measured 4K build times; other sizes one share per network), the step, the
 * elapsed time, and Stop / Build now. Jobs never build: until a range is built, its clips run on CUDA.
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
  const steps = buildSteps(p.ranges);
  const canStart = p.status !== "running" && p.status !== "done";
  return (
    <>
      <p className="hint-text">The app builds the sizes ticked below in the background and pauses while you key. Until a size is built, its clips run on CUDA.</p>
      <More>
        <p className="hint-text">Jobs never wait on a TensorRT build. It builds again only after a graphics driver, TensorRT or model update. {TRT_BUILD_TEXT}</p>
      </More>
      <TrtSizes trt={trt} />
      {p.status === "running" && (
        <>
          <ProgressBar label="TensorRT networks built" value={steps.done} max={steps.total} />
          <p className="hint-text">
            {step ?? "Starting the engine"} · {steps.done} of {steps.total} networks done · {p.startedAt ? `${duration((Date.now() - p.startedAt) / 1000)} elapsed` : ""}
          </p>
        </>
      )}
      {p.status === "paused" && <p className="hint-text">Paused while the queue runs; it goes on by itself when the queue stops.</p>}
      {p.status === "blocked" && <p className="hint-text">Not started: {p.note}. It starts by itself once the card is free; Build now starts it anyway.</p>}
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

/** A size range's state and costs, under its tick: what is built and what it took here, or the measured cost before. */
function sizeNote(trt: TrtState, key: string): string {
  // loop: HOT-PATH-OK — a few built ranges, per row per render
  const all = trt.onDisk.filter((d) => d.range.startsWith(`${key}_t`));
  // the windows the engine uses (built from the models it runs with); stale ones are built for other model files
  // loop: NOT-WORTH — a few ranges on disk
  const onDisk = all.filter((d) => !d.stale);
  // loop: NOT-WORTH — the few chosen sizes
  const r = trt.prebuild.ranges.find((x) => trtSizeKey(x.width, x.height) === key);
  const range = sizeRangeText(key);
  if (r?.state === "building")
    return `${range} · building: ${r.piece ? `${PIECE_NAMES[r.piece] ?? r.piece} (network ${TRT_PIECES.indexOf(r.piece as (typeof TRT_PIECES)[number]) + 1} of ${TRT_PIECES.length})` : "starting"}`;
  if (r?.state === "failed") return `${range} · couldn't be built: ${r.error}`;
  if (!onDisk.length && all.length) {
    // built for the model files the engine had before: it runs on CUDA until built again (ticked, the background build
    // and Build now rebuild it; unticked, ticking it does)
    // loop: NOT-WORTH — a few ranges on disk
    const bytes = all.reduce((n, d) => n + d.bytes, 0);
    return `${range} · built for other models · needs a rebuild (the model set changed) · ${gbBytes(bytes)} on disk`;
  }
  if (onDisk.length) {
    // loop: NOT-WORTH — a few built ranges
    const bytes = onDisk.reduce((n, d) => n + d.bytes, 0);
    // loop: NOT-WORTH — as above
    const secs = onDisk.map((d) => d.buildSeconds).filter((x): x is number => x !== null);
    // loop: NOT-WORTH — at most five networks
    const fell = Object.keys(r?.fallbacks ?? {}).map((k) => PIECE_NAMES[k] ?? k);
    // loop: NOT-WORTH — a few built ranges
    const windows = onDisk.map((d) => rangeText(d.range).replace(/^up to \d+×\d+, /, "")).join("; ");
    return `${range} · built (${windows})${fell.length ? `, ${fell.join(", ")} on CUDA` : ""} · ${gbBytes(bytes)} on disk · ${secs.length ? `the build took ${duration(secs[0])} here` : "build time not recorded"}`;
  }
  return `${range} · ${r ? "chosen, not built yet" : "not built"} · ${TRT_BUILD_COST}`;
}

/**
 * Which sizes TensorRT builds for (backlog row 56): the engine's size ranges with common sizes named, each ticked when
 * it is built or chosen, with what it costs (measured here once built; the measured cost before). Tick: it is built
 * now in the background; untick: its engines are removed (asked first). Plus a size of your own, and the named sizes
 * past TensorRT's ranges (CUDA). The chosen sizes are the background build's list (prebuild.ranges).
 */
function TrtSizes({ trt }: { trt: TrtState }) {
  const p = trt.prebuild;
  // loop: HOT-PATH-OK — the few chosen sizes per render
  const chosen: TrtSize[] = p.ranges.map((r) => ({ label: r.label, width: r.width, height: r.height }));
  const { rows, outside } = trtSizeRows(chosen, trt.built);
  const [w, setW] = useState(2560);
  const [h, setH] = useState(1440);
  // what the main process takes (sides from 16 px) and TensorRT's ranges: the Build button is enabled only for that
  const own = ownTrtSize(w, h);
  const ownKey = own?.key ?? null;
  // loop: NOT-WORTH — a dozen rows
  const ownRow = ownKey ? rows.find((r) => r.key === ownKey) : undefined;
  // loop: NOT-WORTH — a few sizes in the row
  const ownWith = ownRow?.sizes.map((x) => x.label).join(", ");
  // loop: NOT-WORTH — a few built ranges, the few chosen sizes
  const ownDone = ownKey !== null && (trt.built.some((k) => k.startsWith(`${ownKey}_t`)) || chosen.some((c) => trtSizeKey(c.width, c.height) === ownKey));
  return (
    <>
      <p className="hint-text">{trt.ready ? "Sizes to build for:" : "Sizes to build for, once TensorRT is installed:"}</p>
      <ul className="check-list">
        {/* loop: HOT-PATH-OK — a dozen rows per render */}
        {rows.map((r) => {
          // loop: NOT-WORTH — a few built ranges, the few chosen sizes
          const on = trt.built.some((k) => k.startsWith(`${r.key}_t`)) || chosen.some((c) => trtSizeKey(c.width, c.height) === r.key);
          return (
            <li key={r.key}>
              <label className="checks">
                <input type="checkbox" checked={on} onChange={(e) => void window.ck.trtSize(e.target.checked ? "add" : "remove", r.build)} />
                {/* loop: NOT-WORTH — a few sizes per row */}
                {r.sizes.map(sizeText).join(" · ")}
              </label>
              <p className="size-note">{sizeNote(trt, r.key)}</p>
            </li>
          );
        })}
      </ul>
      {/* loop: NOT-WORTH — two sizes */}
      {outside.length > 0 && <p className="hint-text">Past TensorRT&apos;s sizes, so they run on CUDA: {outside.map(sizeText).join(", ")}.</p>}
      <Row label="A size of my own" hint="Width × height in pixels">
        <div className="file-pick">
          <input type="number" aria-label="Width" min={16} max={16384} step={1} value={w} onChange={(e) => setW(Math.round(Number(e.target.value)) || 0)} />
          ×
          <input type="number" aria-label="Height" min={16} max={16384} step={1} value={h} onChange={(e) => setH(Math.round(Number(e.target.value)) || 0)} />
          <button type="button" className="btn small" disabled={!ownKey || ownDone} onClick={() => own && void window.ck.trtSize("add", own.size)}>
            <Download size={14} /> Build
          </button>
        </div>
      </Row>
      <p className="size-note">
        {ownKey
          ? `${w}×${h} falls in the range ${sizeRangeText(ownKey)}${ownWith ? ` (with ${ownWith})` : ""}: ${ownDone ? "already built or chosen" : "not built"}.`
          : w < 16 || h < 16
            ? `${w}×${h}: each side needs at least 16 px.`
            : `${w}×${h} is past TensorRT's sizes (at most ${TRT_MAX_SIDE} px a side and 4096×2176 in area), so it runs on CUDA.`}
      </p>
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
