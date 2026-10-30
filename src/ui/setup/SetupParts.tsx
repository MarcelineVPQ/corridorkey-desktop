// The first-run install and the ffmpeg check as one control each, shared by the setup page
// (pages/SetupPage.tsx) and the Engine page's panel, so the two never drift apart.
import { Check, Download, FolderSearch, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { FfmpegState, InstallState, TrtPick, TrtState } from "../../shared/types";
import { installMissing } from "../../shared/tasks";
import { AMD_UNTESTED, INSTALL_FIRST } from "../../shared/texts";
import { Row } from "../panel/Section";
import { duration, gbBytes } from "../format";
import {
  PIECE_NAMES,
  buildSteps,
  buildTotals,
  prebuildStep,
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
  SCAN_MAX_CLIPS,
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
 * The TensorRT checklist (Marcy 2026-10-30): why a size needs a build per window, the folder scan for your clips' sizes
 * (what it reads and why), the sizes with a tick per window, what the ticked builds cost, and Build ticked. Nothing
 * builds until it is pressed; the build runs in the background and pauses while you key (electron/main/trtPrebuild.ts).
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
  return (
    <>
      <p className="hint-text">
        TensorRT is built once per clip size and per window: how many frames the model looks at together. A job picks its window from the graphics memory free when it starts, so a size needs a build
        for each window it can pick; without one, that clip runs on CUDA.
      </p>
      <More>
        <p className="hint-text">Jobs never wait on a TensorRT build. It builds again only after a graphics driver, TensorRT or model update. {TRT_BUILD_TEXT}</p>
      </More>
      <ScanBox trt={trt} />
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
      {p.status === "blocked" && <p className="hint-text">Not started: {p.note}. It starts by itself once the card is free; Build ticked starts it anyway.</p>}
      {p.status === "stopped" && <p className="hint-text">Stopped. What was built is kept; Build ticked goes on from there.</p>}
      {p.status === "error" && <p className="notice error">The background build stopped: {p.note}</p>}
    </>
  );
}

/**
 * The folder scan (electron/main/trtScan.ts), with what it reads and why: the app doesn't know your clips' sizes until
 * it has seen them, and the checklist ticks the windows of the sizes your clips use.
 */
function ScanBox({ trt }: { trt: TrtState }) {
  const s = trt.scan;
  // loop: NOT-WORTH — the few sizes found
  const found = s.found.map((f) => `${f.width}×${f.height} (${f.clips} clip${f.clips === 1 ? "" : "s"})`).join(", ");
  return (
    <>
      <p className="hint-text">
        <strong>Which sizes do your clips come in?</strong> The app needs to know, so it can tick the builds your clips will use. Scan a clips folder reads only each clip&apos;s width and height
        (ffprobe for a video, the first frame of an image sequence): nothing is keyed, copied, changed or sent anywhere. It looks in the folder you choose and two folders under it, at most{" "}
        {SCAN_MAX_CLIPS} clips. Clips you add to the queue are remembered the same way.
      </p>
      <div className="file-pick">
        {s.status === "running" ? (
          <button type="button" className="btn small" onClick={() => void window.ck.trtPrebuild("stopScan")}>
            <X size={14} /> Stop scan
          </button>
        ) : (
          <button type="button" className="btn small" disabled={!trt.ready} onClick={() => void window.ck.trtPrebuild("scan")}>
            <FolderSearch size={14} /> Scan a clips folder…
          </button>
        )}
      </div>
      {s.status === "running" && <p className="size-note">{`Reading ${s.folder}: ${s.clips} clips${found ? `, ${found}` : ""}`}</p>}
      {(s.status === "done" || s.status === "stopped") && (
        <p className="size-note">
          {`${s.status === "stopped" ? "Stopped" : "Scanned"} ${s.folder}: ${s.clips} clip${s.clips === 1 ? "" : "s"}${found ? `, ${found}` : ", no clips found"}`}
          {s.unreadable ? ` · ${s.unreadable} couldn't be read` : ""}
          {s.capped ? ` · stopped at ${SCAN_MAX_CLIPS} clips` : ""}
          {found ? " · their windows are ticked below" : ""}
        </p>
      )}
      {s.status === "error" && <p className="notice error">The scan stopped: {s.note}</p>}
    </>
  );
}

/** A size range's state under its row: what is built and what it took here, or what it would cost. */
function sizeNote(trt: TrtState, key: string): string {
  // loop: HOT-PATH-OK — a few built ranges, per row per render
  const all = trt.onDisk.filter((d) => d.range.startsWith(`${key}_t`));
  // the windows the engine uses (built from the models it runs with); stale ones are built for other model files
  // loop: NOT-WORTH — a few ranges on disk
  const onDisk = all.filter((d) => !d.stale);
  // loop: NOT-WORTH — the few builds in the list
  const r = trt.prebuild.ranges.find((x) => trtSizeKey(x.width, x.height) === key && (x.state === "building" || x.state === "failed"));
  const range = sizeRangeText(key);
  if (r?.state === "building")
    return `${range} · building${r.window ? ` up to ${r.window} frames` : ""}: ${r.piece ? `${PIECE_NAMES[r.piece] ?? r.piece} (network ${TRT_PIECES.indexOf(r.piece as (typeof TRT_PIECES)[number]) + 1} of ${TRT_PIECES.length})` : "starting"}`;
  if (r?.state === "failed") return `${range} · couldn't be built: ${r.error}`;
  if (!onDisk.length && all.length) {
    // loop: NOT-WORTH — a few ranges on disk
    const bytes = all.reduce((n, d) => n + d.bytes, 0);
    return `${range} · built for other models · needs a rebuild (the model set changed) · ${gbBytes(bytes)} on disk`;
  }
  if (onDisk.length) {
    // loop: NOT-WORTH — a few built ranges
    const bytes = onDisk.reduce((n, d) => n + d.bytes, 0);
    // loop: NOT-WORTH — as above
    const secs = onDisk.map((d) => d.buildSeconds).filter((x): x is number => x !== null);
    return `${range} · ${gbBytes(bytes)} on disk · ${secs.length ? `a build took ${duration(secs[0])} here` : "build time not recorded"}`;
  }
  return `${range} · not built · ${TRT_BUILD_COST} per window`;
}

/**
 * The checklist: the engine's size ranges with common sizes named (and your clips' sizes), a tick per size (the sizes
 * your clips use) and a tick per window (each its own build), built ones ticked and fixed, with Remove. The ticks are
 * a plan: Build ticked builds the ticked windows not built yet, and nothing else does.
 */
function TrtSizes({ trt }: { trt: TrtState }) {
  const { rows, outside } = trtSizeRows(trt.sizes, trt.built);
  // windows ticked or unticked against their size's tick (a size your clips use starts with every window ticked)
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const [w, setW] = useState(2560);
  const [h, setH] = useState(1440);
  // the windows this card builds, read once the page shows them (a short-lived engine, between jobs)
  const needWindows = trt.ready && trt.windows === null && !trt.windowsNote;
  useEffect(() => {
    if (needWindows) void window.ck.trtPrebuild("windows");
  }, [needWindows]);
  // loop: NOT-WORTH — the few sizes in the list, per check
  const used = (key: string) => trt.sizes.some((s) => trtSizeKey(s.width, s.height) === key);
  const flip = (range: string) =>
    setFlipped((f) => {
      const n = new Set(f);
      if (!n.delete(range)) n.add(range);
      return n;
    });
  const built = (range: string) => trt.built.includes(range);
  const ticked = (key: string, range: string) => built(range) || used(key) !== flipped.has(range);
  // loop: HOT-PATH-OK — a dozen rows, a few windows each, per render
  const picks: TrtPick[] = rows.flatMap((r) =>
    // loop: NOT-WORTH — a few windows per size
    (trt.windows?.[r.key] ?? []).filter((x) => !built(x.range) && ticked(r.key, x.range)).map((x) => ({ ...r.build, window: x.window, range: x.range })),
  );
  const cost = buildTotals(picks.length, trt.onDisk);
  const minutes = cost.here ? `about ${Math.round(cost.minutes[0])} min` : `about ${Math.round(cost.minutes[0])}-${Math.round(cost.minutes[1])} min`;
  const running = trt.prebuild.status === "running";
  // what the main process takes (sides from 16 px) and TensorRT's ranges: Add is enabled only for that
  const own = ownTrtSize(w, h);
  const ownKey = own?.key ?? null;
  // loop: NOT-WORTH — a dozen rows
  const ownRow = ownKey ? rows.find((r) => r.key === ownKey) : undefined;
  // loop: NOT-WORTH — a few sizes in the row
  const ownWith = ownRow?.sizes.map((x) => x.label).join(", ");
  const ownDone = ownKey !== null && used(ownKey);
  return (
    <>
      <p className="hint-text">{trt.ready ? "Ticked: the sizes your clips use, every window. Nothing builds until you press Build ticked." : "Sizes to build for, once TensorRT is installed:"}</p>
      {trt.windowsNote && <p className="notice error">The windows this card builds couldn&apos;t be read: {trt.windowsNote}</p>}
      <ul className="check-list">
        {/* loop: HOT-PATH-OK — a dozen rows per render */}
        {rows.map((r) => {
          // loop: NOT-WORTH — a few built ranges
          const onDisk = trt.onDisk.filter((d) => d.range.startsWith(`${r.key}_t`));
          const wins = trt.windows?.[r.key];
          return (
            <li key={r.key}>
              <label className="checks">
                <input
                  type="checkbox"
                  checked={used(r.key)}
                  onChange={(e) => {
                    // a size's tick sets all its windows again
                    // loop: NOT-WORTH — a few windows of one size
                    setFlipped((f) => new Set([...f].filter((x) => !x.startsWith(`${r.key}_t`))));
                    void window.ck.trtSize(e.target.checked ? "add" : "forget", r.build);
                  }}
                />
                {/* loop: NOT-WORTH — a few sizes per row */}
                {r.sizes.map(sizeText).join(" · ")}
              </label>
              {wins && wins.length > 0 && (
                <div className="checks trt-windows">
                  {/* loop: NOT-WORTH — a few windows per size */}
                  {wins.map((x) => (
                    <label key={x.range}>
                      <input type="checkbox" checked={ticked(r.key, x.range)} disabled={built(x.range) || running} onChange={() => flip(x.range)} />
                      {`up to ${x.window} frames${built(x.range) ? " (built)" : ""}`}
                    </label>
                  ))}
                </div>
              )}
              {trt.ready && wins === undefined && trt.windows !== null && <p className="size-note">This card can&apos;t build TensorRT at this size.</p>}
              {trt.ready && trt.windows === null && !trt.windowsNote && <p className="size-note">Reading the windows this card builds…</p>}
              <p className="size-note">
                {sizeNote(trt, r.key)}
                {onDisk.length > 0 && !running && (
                  <>
                    {" · "}
                    <button type="button" className="link-btn" onClick={() => void window.ck.trtSize("remove", r.build)}>
                      Remove
                    </button>
                  </>
                )}
              </p>
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
            Add
          </button>
        </div>
      </Row>
      <p className="size-note">
        {ownKey
          ? `${w}×${h} falls in the range ${sizeRangeText(ownKey)}${ownWith ? ` (with ${ownWith})` : ""}: ${ownDone ? "already in the list" : "Add ticks its windows"}.`
          : w < 16 || h < 16
            ? `${w}×${h}: each side needs at least 16 px.`
            : `${w}×${h} is past TensorRT's sizes (at most ${TRT_MAX_SIDE} px a side and 4096×2176 in area), so it runs on CUDA.`}
      </p>
      <p className="hint-text">
        {picks.length
          ? `${picks.length} to build · about ${gbBytes(cost.bytes)} · ${minutes}${cost.here ? " (from this card's builds)" : " (measured on an RTX 5080)"}`
          : "Nothing ticked to build: every ticked window is built."}
      </p>
      <div className="file-pick">
        {running ? (
          <button type="button" className="btn small" onClick={() => void window.ck.trtPrebuild("stop")}>
            <X size={14} /> Stop
          </button>
        ) : (
          <button type="button" className="btn small primary" disabled={!picks.length || trt.prebuild.status === "paused"} onClick={() => void window.ck.trtPrebuild("start", picks)}>
            <Download size={14} /> Build ticked
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
