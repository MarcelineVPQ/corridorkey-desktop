// The Queue page's panel: the selected clip's settings, one Section each.
// Every control maps to one engine option (docs/ENGINE_PROTOCOL.md) and
// changes what the run does (rule 4). Locked once the clip has run.
import { Clapperboard, Film, FolderOpen, Layers, MemoryStick, Scaling, SunMedium, Wand2, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { HintFileKind, Job, JobOptions, MemoryChoice, MemoryEstimate, MemoryEstimateResult, ModelScale, OutputName, TrtState, VideoCodec, WindowEstimate } from "../shared/types";
import { LINEAR_RANGES, MANUAL_WINDOWS, OUTPUT_NAMES, VRAM_LIMIT_AUTO_HELP, scaledSize, videoCodecsFor, vramLimitChoices, withCutoutAlpha } from "../shared/types";
import { gibBytes } from "../shared/units";
import { AS_USED } from "../shared/texts";
import { builtWindows, sizeRangeText, trtSizeKey, TRT_BUILD_COST, TRT_SPEED, type TrtSize } from "../shared/trt";
import { Accordion, Row, Section, Segmented } from "./panel/Section";
import { More } from "./More";
import { PathText } from "./PathText";

const OUTPUT_TEXT: Record<OutputName, { label: string; help: string }> = {
  alpha: { label: "Alpha", help: "the matte" },
  fg: { label: "Foreground", help: "the predicted foreground color" },
  checker: { label: "Checker", help: "foreground over a checkerboard, despilled" },
  cutout: { label: "Cutout", help: "premultiplied color + alpha, despilled" },
};
// no video codec here carries alpha (backlog row 26): the video cutout's alpha is the Alpha output
const VIDEO_CUTOUT_HELP = "premultiplied color, despilled; its alpha is the Alpha output (video has no alpha channel)";

// the codec menu's names and what each one is (README, Quality, "Video outputs" has the measurements)
const CODEC_TEXT: Record<VideoCodec, { label: string; short: string; hint: string }> = {
  "h264-lossless": { label: "Lossless H.264, 10-bit 4:4:4", short: "lossless H.264", hint: "Only the 10-bit rounding is lost (.mp4); large files" },
  dnxhr444: { label: "DNxHR 444, 10-bit", short: "DNxHR 444", hint: "Avid's edit and finishing codec (.mov): matte within 1.3/255" },
  "h264-crf12": { label: "H.264 CRF 12 (small files)", short: "H.264 CRF 12", hint: "The original's output: small files; hair edges off by up to 21/255" },
};

const MATTE_HELP = "White = subject, black = background"; // theme-exempt: prose about the matte's values, not a color

const HINT_TEXT = { none: "No hint", "first-frame": "First-frame matte", video: "Hint video" } as const;

// Internal resolution (backlog row 42): the plugin's names for the original's --model_scale
const SCALE_TEXT: Record<ModelScale, string> = { 1: "Full", 0.75: "¾", 0.5: "½", 0.25: "¼" };
const SCALE_OPTIONS: [string, string][] = [
  ["1", SCALE_TEXT[1]],
  ["0.75", SCALE_TEXT[0.75]],
  ["0.5", SCALE_TEXT[0.5]],
  ["0.25", SCALE_TEXT[0.25]],
];

export function JobSettings({
  job,
  focus,
  sectionTasks,
  queueRunning,
  platform,
  tensorrt,
  onChange,
}: {
  job: Job;
  focus: string | null;
  sectionTasks: Record<string, string>;
  queueRunning: boolean;
  platform: string;
  // the TensorRT setting and what is built (a waiting clip's line); absent: no line
  tensorrt?: TrtState;
  onChange: (o: JobOptions) => void;
}) {
  const o = job.options;
  // a video cutout always comes with the Alpha output (its alpha)
  const set = (patch: Partial<JobOptions>) => onChange(withCutoutAlpha({ ...o, ...patch }));
  const video = o.outputFormat === "video";
  const alphaForCutout = video && o.outputs.includes("cutout");
  const codecs = videoCodecsFor(platform);
  const codec: VideoCodec = o.videoCodec;
  const pickable = codecs.length > 1;
  const locked = job.status !== "waiting" ? AS_USED : null;
  const pick = async (kind: HintFileKind) => {
    const path = await window.ck.pickFile(kind);
    if (path) set(kind === "hint-image" ? { hintFirstFrame: path, hintMode: "first-frame" } : { hintVideo: path, hintMode: "video" });
  };
  const toggleOutput = (name: OutputName) => {
    const has = o.outputs.includes(name);
    if (has && o.outputs.length === 1) return; // at least one output
    // loop: NOT-WORTH — four outputs per click
    set({ outputs: has ? o.outputs.filter((x) => x !== name) : OUTPUT_NAMES.filter((x) => x === name || o.outputs.includes(x)) });
  };
  const despillUsed = o.outputs.includes("checker") || o.outputs.includes("cutout");
  const hintFile = o.hintMode === "first-frame" ? o.hintFirstFrame : o.hintMode === "video" ? o.hintVideo : null;
  const hintStatus = o.hintMode === "none" ? "No hint · the model picks the subject" : `${HINT_TEXT[o.hintMode]} · trust ${o.hintQuality.toFixed(2)}${hintFile ? "" : " · no file yet"}`;
  const memLimit = o.vramLimitGb !== null && platform !== "darwin" ? ` · limit ${o.vramLimitGb} GiB` : "";
  const memStatus = (o.memory.auto ? "Automatic · from free graphics memory" : `Manual · ${o.memory.hannChunk}/${o.memory.hannStride}${o.memory.lowVram ? " · low-memory" : ""}`) + memLimit;
  // loop: HOT-PATH-OK — ≤ four outputs per render
  const outStatus = `${o.outputs.map((x) => OUTPUT_TEXT[x].label).join(", ")} · ${video ? CODEC_TEXT[codec].short : `EXR ${o.exrDtype}`}`;
  const scale: ModelScale = o.modelScale;
  const { width: cw, height: ch } = job.clip;
  const inside = cw && ch ? `${scaledSize(cw, scale)}×${scaledSize(ch, scale)}` : null;
  const scaleStatus = scale === 1 ? `Full${cw && ch ? ` · ${cw}×${ch}` : ""}` : `${SCALE_TEXT[scale]}${inside ? ` · the networks run at ${inside}` : ""}`;
  const scaleHint =
    scale === 1
      ? "The networks run at the clip's own size"
      : `Faster and lighter; the result is resized back to ${cw && ch ? `${cw}×${ch}` : "the clip's size"} (Lanczos, as the original), with less edge detail`;
  // input precision (backlog row 27): off = CorridorKey 2.0's own 8-bit read
  const deep = o.deepInput;
  const deepStatus = deep ? "16-bit · differs from CorridorKey 2.0" : "8-bit · as CorridorKey 2.0 reads it";
  const deepHint = deep
    ? "10/12-bit video and 16-bit PNG reach the model in full; 8-bit clips and EXR are the same either way"
    : "Off: the same 8-bit read as CorridorKey 2.0, byte for byte. On keeps every bit of 10/12-bit video and 16-bit PNG";
  const linearSet = o.linearBrightness !== 1 || o.linearContrast !== 1;
  const linearStatus = linearSet
    ? `Brightness ${o.linearBrightness.toFixed(2)} · contrast ${o.linearContrast.toFixed(2)}${o.linearContrast !== 1 ? ` around ${o.linearContrastPivot.toFixed(2)}` : ""}`
    : "Off · as shot";

  const trtPlan = job.status === "waiting" && tensorrt ? trtPlanFor(job, tensorrt) : null;

  return (
    <Accordion page="queue" focus={focus}>
      <Section id="hint" icon={Wand2} title="Hint" status={hintStatus} task={sectionTasks["queue/hint"] ?? null} disabled={locked}>
        {() => (
          <>
            <Row label="Mode">
              <Segmented label="Hint mode" value={o.hintMode} options={Object.entries(HINT_TEXT) as [JobOptions["hintMode"], string][]} onChange={(hintMode) => set({ hintMode })} />
            </Row>
            {o.hintMode === "first-frame" && (
              <Row label="Matte image" hint={MATTE_HELP}>
                <FilePick path={o.hintFirstFrame} onPick={() => pick("hint-image")} onClear={() => set({ hintFirstFrame: null })} />
              </Row>
            )}
            {o.hintMode === "video" && (
              <Row label="Hint video" hint="A matte for every frame (video or frame folder)">
                <FilePick path={o.hintVideo} onPick={() => pick("hint-video")} onClear={() => set({ hintVideo: null })} />
              </Row>
            )}
            {o.hintMode !== "none" && (
              <>
                <Row label="Hint trust" hint="0.95 artist matte · 0.75 rough · ≤ 0.5 loose" htmlFor="hq">
                  <div className="range">
                    <input id="hq" type="range" min={0.3} max={1} step={0.05} value={o.hintQuality} onChange={(e) => set({ hintQuality: Number(e.target.value) })} />
                    <output>{o.hintQuality.toFixed(2)}</output>
                  </div>
                </Row>
                <Row label="Carry">
                  <label className="checks">
                    <input type="checkbox" checked={o.carryHint} onChange={(e) => set({ carryHint: e.target.checked })} />
                    Carry the model's matte between windows
                  </label>
                </Row>
              </>
            )}
          </>
        )}
      </Section>

      <Section id="outputs" icon={Film} title="Outputs" status={outStatus} disabled={locked}>
        {() => (
          <>
            <Row label="Files">
              <div className="checks">
                {/* loop: HOT-PATH-OK — four outputs per render */}
                {OUTPUT_NAMES.map((name) => {
                  const locked = name === "alpha" && alphaForCutout;
                  const help = locked ? "the matte; also the video cutout's alpha, so it stays on while Cutout is on" : name === "cutout" && video ? VIDEO_CUTOUT_HELP : OUTPUT_TEXT[name].help;
                  return (
                    <label key={name} title={help}>
                      <input type="checkbox" checked={o.outputs.includes(name)} disabled={locked} onChange={() => toggleOutput(name)} />
                      {OUTPUT_TEXT[name].label}
                    </label>
                  );
                })}
              </div>
            </Row>
            <Row label="Format" hint={o.outputFormat === "exr" ? "Scene-linear, unclamped HDR: the exact deliverable" : "Display-referred sRGB / Rec.709; EXR is the exact deliverable"}>
              <Segmented
                label="Output format"
                value={o.outputFormat}
                options={[
                  ["video", "Video, 10-bit"],
                  ["exr", "EXR sequence"],
                ]}
                onChange={(outputFormat) => set({ outputFormat })}
              />
            </Row>
            {video && (
              <Row label="Codec" hint={CODEC_TEXT[codec].hint} htmlFor={pickable ? "codec" : undefined}>
                {!pickable ? (
                  <span>
                    {CODEC_TEXT[codec].label}
                    {platform === "darwin" ? " · ProRes 4444 XQ comes with the Mac release" : ""}
                  </span>
                ) : (
                  <select id="codec" value={codec} onChange={(e) => set({ videoCodec: e.target.value as VideoCodec })}>
                    {/* loop: HOT-PATH-OK — three codecs per render */}
                    {codecs.map((c) => (
                      <option key={c} value={c}>
                        {CODEC_TEXT[c].label}
                      </option>
                    ))}
                  </select>
                )}
              </Row>
            )}
            {o.outputFormat === "exr" && (
              <Row label="EXR pixel type">
                <Segmented
                  label="EXR pixel type"
                  value={o.exrDtype}
                  options={[
                    ["half", "half"],
                    ["float", "float"],
                  ]}
                  onChange={(exrDtype) => set({ exrDtype })}
                />
              </Row>
            )}
            {despillUsed && (
              <Row label="Despill" hint="Checker and cutout only" htmlFor="ds">
                <div className="range">
                  <input id="ds" type="range" min={0} max={1} step={0.05} value={o.despillStrength} onChange={(e) => set({ despillStrength: Number(e.target.value) })} />
                  <output>{o.despillStrength.toFixed(2)}</output>
                </div>
              </Row>
            )}
            {o.outputs.includes("cutout") && o.outputFormat === "video" && (
              <Row label="Cutout color" hint="Premultiplied, no alpha channel: its alpha is the Alpha output">
                <label className="checks">
                  <input type="checkbox" checked={o.cutoutLinear} onChange={(e) => set({ cutoutLinear: e.target.checked })} />
                  Scene-linear instead of sRGB
                </label>
              </Row>
            )}
          </>
        )}
      </Section>

      {job.clip.kind === "frames" && (
        <Section id="frames" icon={Clapperboard} title="Frame folder" status={`${o.frameDirFps} fps · ${o.frameDirLinear ? "scene-linear" : "display-coded"}`} disabled={locked}>
          {() => (
            <>
              <Row label="Frame rate" htmlFor="fps">
                <input id="fps" type="number" min={1} max={240} step={0.001} value={o.frameDirFps} onChange={(e) => set({ frameDirFps: Number(e.target.value) || 24 })} />
              </Row>
              <Row label="Color">
                <label className="checks">
                  <input type="checkbox" checked={o.frameDirLinear} onChange={(e) => set({ frameDirLinear: e.target.checked })} />
                  Frames are scene-linear (linear EXR plates)
                </label>
              </Row>
            </>
          )}
        </Section>
      )}

      <Section id="resolution" icon={Scaling} title="Internal resolution" status={scaleStatus} disabled={locked}>
        {() => (
          <Row label="Resolution" hint={scaleHint}>
            <Segmented label="Internal resolution" value={String(o.modelScale)} options={SCALE_OPTIONS} onChange={(v) => set({ modelScale: Number(v) as ModelScale })} />
          </Row>
        )}
      </Section>

      <Section id="input-depth" icon={Layers} title="Input precision" status={deepStatus} disabled={locked}>
        {() => (
          <Row label="Bit depth" hint={deepHint}>
            <label className="checks">
              <input type="checkbox" checked={o.deepInput} onChange={(e) => set({ deepInput: e.target.checked })} />
              Read 10/12-bit plates at 16 bits (differs from CorridorKey 2.0)
            </label>
          </Row>
        )}
      </Section>

      {job.clip.kind === "video" && (
        <Section id="linear" icon={SunMedium} title="Linear exposure" status={linearStatus} disabled={locked}>
          {() => (
            <>
              <Row label="Brightness" hint="Gain on the scene-linear frames the networks see; the foreground is turned back after" htmlFor="lb">
                <div className="range">
                  <input
                    id="lb"
                    type="range"
                    min={LINEAR_RANGES.brightness[0]}
                    max={LINEAR_RANGES.brightness[1]}
                    step={0.05}
                    value={o.linearBrightness}
                    onChange={(e) => set({ linearBrightness: Number(e.target.value) })}
                  />
                  <output>{o.linearBrightness.toFixed(2)}</output>
                </div>
              </Row>
              <Row label="Contrast" hint="Around the pivot, in linear light" htmlFor="lc">
                <div className="range">
                  <input
                    id="lc"
                    type="range"
                    min={LINEAR_RANGES.contrast[0]}
                    max={LINEAR_RANGES.contrast[1]}
                    step={0.05}
                    value={o.linearContrast}
                    onChange={(e) => set({ linearContrast: Number(e.target.value) })}
                  />
                  <output>{o.linearContrast.toFixed(2)}</output>
                </div>
              </Row>
              {o.linearContrast !== 1 && (
                <Row label="Contrast pivot" hint="0.18 = mid grey" htmlFor="lp">
                  <div className="range">
                    <input
                      id="lp"
                      type="range"
                      min={LINEAR_RANGES.pivot[0]}
                      max={LINEAR_RANGES.pivot[1]}
                      step={0.01}
                      value={o.linearContrastPivot}
                      onChange={(e) => set({ linearContrastPivot: Number(e.target.value) })}
                    />
                    <output>{o.linearContrastPivot.toFixed(2)}</output>
                  </div>
                </Row>
              )}
              {linearSet && (
                <Row label="">
                  <button type="button" className="btn small" onClick={() => set({ linearBrightness: 1, linearContrast: 1, linearContrastPivot: 0.18 })}>
                    Reset to 1.00 / 1.00 / 0.18
                  </button>
                </Row>
              )}
            </>
          )}
        </Section>
      )}

      <Section id="memory" icon={MemoryStick} title="Graphics memory" status={memStatus} disabled={locked}>
        {() => <MemorySection job={job} options={o} queueRunning={queueRunning} platform={platform} set={set} />}
      </Section>

      {trtPlan && (
        <Section id="tensorrt" icon={Zap} title="TensorRT" status={trtPlan.status}>
          {() => (
            <>
              <p className="hint-text">{trtPlan.text}</p>
              {trtPlan.build && (
                <>
                  <button type="button" className="btn small" onClick={() => void window.ck.trtSize("add", trtPlan.build!)}>
                    <Zap size={14} /> Build for this clip&apos;s size
                  </button>
                  <p className="size-note">
                    {trtPlan.build.width}×{trtPlan.build.height}, range {sizeRangeText(trtSizeKey(trtPlan.build.width, trtPlan.build.height)!)}: built once in the background (it waits while the queue
                    runs): {TRT_BUILD_COST}. Engine settings, TensorRT lists it.
                  </p>
                </>
              )}
              <More>
                <p className="hint-text">The choice is in Engine settings, TensorRT. What really ran shows on the clip&apos;s page once it starts. {TRT_SPEED}</p>
              </More>
            </>
          )}
        </Section>
      )}
    </Accordion>
  );
}

/**
 * What a waiting clip will ask for and run on, before it runs: the setting, the parts, whether its size's TensorRT
 * range is built (the cache). Null where TensorRT doesn't exist (Windows, macOS).
 */
export function trtPlanFor(job: Job, trt: TrtState): { status: string; text: string; build?: TrtSize } | null {
  if (!trt.supported) return null;
  const { width, height } = job.clip;
  const key = width && height && job.options.modelScale === 1 ? trtSizeKey(width, height) : null;
  if (!trt.on) return { status: "Off · runs on CUDA", text: "TensorRT is off, so this clip runs on CUDA." };
  if (!trt.ready) return { status: "On, not installed · runs on CUDA", text: "TensorRT's parts aren't installed, so this clip runs on CUDA." };
  if (job.options.modelScale !== 1)
    return {
      status: "On · depends on the internal resolution",
      text: "The internal resolution sets the size the networks run at, and so the TensorRT range; it runs on TensorRT where that range is built.",
    };
  if (!width || !height) return { status: "On", text: "Used where the clip's size has a built TensorRT range; the clip's size isn't known yet." };
  if (!key) return { status: "Outside TensorRT's ranges · CUDA", text: `${width}×${height} is outside the sizes TensorRT is built for (up to 4096×2176), so it runs on CUDA.` };
  const windows = builtWindows(key, trt.built);
  if (windows.length)
    return {
      // not "built for this size": a range is used only at its own window, and a short clip's automatic window is
      // often another (bug hunt 2026-10-26 T1)
      status: `On · built for a window of ${windows.join(" or ")} frames`,
      text: `Built for ${width}×${height} with windows up to ${windows.join(" or ")} frames: it runs on TensorRT when the job's automatic window is one of those (at 4K on a 16 GB card it is 8).`,
    };
  // loop: NOT-WORTH — two ranges
  const building = trt.prebuild.status === "running" && trt.prebuild.ranges.some((r) => trtSizeKey(r.width, r.height) === key && r.state !== "done");
  // loop: NOT-WORTH — the few chosen sizes
  const chosen = trt.prebuild.ranges.some((r) => trtSizeKey(r.width, r.height) === key);
  return {
    status: building ? "On · building in the background · CUDA until then" : chosen ? "On · chosen, not built yet · runs on CUDA" : "On · not built for this size · runs on CUDA",
    text: building
      ? "TensorRT for this size is building in the background now (Engine settings, TensorRT); if this clip starts first, it runs on CUDA."
      : `TensorRT isn't built for ${width}×${height} yet, so this clip runs on CUDA: jobs never wait on a build.`,
    // building it: this clip's own size (its window is the one the build picks for it)
    build: building ? undefined : { label: job.clip.name, width, height },
  };
}

type ManualChoice = Extract<MemoryChoice, { auto: false }>;

/**
 * The Graphics memory section: the temporal window (Automatic / Manual) and the graphics memory limit (backlog row
 * 43). Rendered only while the section is open, so the engine's `estimate` (row 41: a short-lived engine, no
 * graphics memory held) is asked only then, for this clip under its limit; the numbers are the engine's (rule 1).
 */
function MemorySection({ job, options: o, queueRunning, platform, set }: { job: Job; options: JobOptions; queueRunning: boolean; platform: string; set: (patch: Partial<JobOptions>) => void }) {
  const [est, setEst] = useState<MemoryEstimateResult | null>(null);
  // a clip that ran shows the window it really used (JobView); the estimate is for choosing one
  const waiting = job.status === "waiting";
  useEffect(() => {
    let live = true;
    setEst(null);
    if (!waiting) return;
    // one ask per clip shown and limit (and again when the queue starts or ends: the engine's reading changes)
    void window.ck.estimateMemory(job.id).then((r) => live && setEst(r));
    return () => {
      live = false;
    };
  }, [job.id, job.clip.path, queueRunning, waiting, o.vramLimitGb, o.modelScale]);
  const e = est?.ok ? est.estimate : null;
  return (
    <>
      <Row label="Temporal window" hint={o.memory.auto ? `Largest that fits when the job starts${o.vramLimitGb !== null ? `, within ${o.vramLimitGb} GiB` : ""}` : undefined}>
        <Segmented
          label="Memory mode"
          value={o.memory.auto ? "auto" : "manual"}
          options={[
            ["auto", "Automatic"],
            ["manual", "Manual"],
          ]}
          onChange={(v) => set({ memory: v === "auto" ? { auto: true } : { auto: false, hannChunk: 24, hannStride: 12, lowVram: false } })}
        />
      </Row>
      {/* Core ML takes its window from the model set: the limit isn't used on a Mac (no control that does nothing) */}
      {platform !== "darwin" && (
        <VramLimitRow
          id="vlimit"
          value={o.vramLimitGb}
          totalBytes={e?.totalBytes ?? null}
          cardText={waiting ? cardText(est, e) : null}
          provider={e?.provider ?? null}
          onChange={(vramLimitGb) => set({ vramLimitGb })}
        />
      )}
      {!o.memory.auto && <ManualMemory est={est} waiting={waiting} memory={o.memory} onChange={(memory) => set({ memory })} />}
    </>
  );
}

/** The card's memory as the engine's estimate read it, for the limit row (null: nothing to say yet). */
function cardText(est: MemoryEstimateResult | null, e: MemoryEstimate | null): string {
  if (!est) return "Reading the card's memory…";
  if (!e) return est.ok ? "" : est.reason;
  if (e.totalBytes === null && e.freeBytes === null) return "This system gives no graphics memory reading.";
  const parts = [e.totalBytes !== null ? `This card: ${gibBytes(e.totalBytes)}` : "This card", e.freeBytes !== null ? `${gibBytes(e.freeBytes)} free` : null];
  // loop: NOT-WORTH — two parts per render
  return `${parts.filter(Boolean).join(", ")}${est.ok && est.stale ? " (read before the queue started)" : ""}`;
}

/**
 * Graphics memory limit: Auto / N GiB (backlog row 43), the engine's `vram_budget_gb`. Shared by a clip's settings
 * and App settings' default. The menu runs up to the card's size once the engine has read it.
 */
export function VramLimitRow({
  id,
  value,
  totalBytes,
  cardText,
  provider,
  onChange,
}: {
  id: string;
  value: number | null;
  totalBytes: number | null;
  cardText: string | null;
  provider: string | null;
  onChange: (gb: number | null) => void;
}) {
  const choices = vramLimitChoices(totalBytes, value);
  const what =
    provider === "cpu"
      ? "Not used on the CPU (no graphics card in use)."
      : value === null
        ? "Auto: the memory free on the card when the job starts."
        : `The automatic window fits within ${value} GiB, and the engine's CUDA memory is capped at it. A manual window isn't resized.`;
  return (
    <Row label="Memory limit" hint={cardText || undefined} htmlFor={id}>
      <select id={id} title={VRAM_LIMIT_AUTO_HELP} value={value === null ? "auto" : String(value)} onChange={(ev) => onChange(ev.target.value === "auto" ? null : Number(ev.target.value))}>
        <option value="auto">Auto</option>
        {/* loop: HOT-PATH-OK — up to the card's GiB (a few dozen) per render */}
        {choices.map((gb) => (
          <option key={gb} value={String(gb)}>
            {gb} GiB
          </option>
        ))}
      </select>
      <p className="estimate" title={VRAM_LIMIT_AUTO_HELP}>
        {what}
      </p>
    </Row>
  );
}

/**
 * Manual window / stride and low-memory mode, each choice with the engine's graphics-memory estimate for this clip
 * (backlog row 41), weighed against the clip's limit when it has one.
 */
function ManualMemory({ est, waiting, memory, onChange }: { est: MemoryEstimateResult | null; waiting: boolean; memory: ManualChoice; onChange: (m: ManualChoice) => void }) {
  const e = est?.ok ? est.estimate : null;
  // loop: HOT-PATH-OK — twelve windows, per lookup (a few per render)
  const of = (c: number, s: number, low: boolean) => e?.windows.find((w) => w.hannChunk === c && w.hannStride === s && w.lowVram === low) ?? null;
  const fitText = (w: WindowEstimate | null) => (w?.fits === false ? " · doesn't fit" : "");
  const cur = of(memory.hannChunk, memory.hannStride, memory.lowVram);
  const other = of(memory.hannChunk, memory.hannStride, !memory.lowVram);
  const lowOn = memory.lowVram ? cur : other;
  const lowOff = memory.lowVram ? other : cur;
  return (
    <>
      <Row label="Window / stride" htmlFor="win">
        <select
          id="win"
          className="window-pick"
          value={`${memory.hannChunk}/${memory.hannStride}`}
          onChange={(ev) => {
            // loop: NOT-WORTH — two numbers per window choice
            const [c, s] = ev.target.value.split("/").map(Number);
            onChange({ ...memory, hannChunk: c, hannStride: s });
          }}
        >
          {/* loop: HOT-PATH-OK — a few window choices per render */}
          {MANUAL_WINDOWS.map(([c, s]) => {
            const w = of(c, s, memory.lowVram);
            return (
              <option key={c} value={`${c}/${s}`}>
                {c} / {s}
                {w ? ` · about ${gibBytes(w.peakBytes)}${fitText(w)}` : ""}
              </option>
            );
          })}
        </select>
      </Row>
      <Row label="Low-memory mode" hint="Less graphics memory, more disk, slower">
        <label className="checks">
          <input type="checkbox" checked={memory.lowVram} onChange={(ev) => onChange({ ...memory, lowVram: ev.target.checked })} />
          Staged inference
        </label>
        {lowOn && lowOff && (
          <p className="estimate">
            On: about {gibBytes(lowOn.peakBytes)}
            {fitText(lowOn)} · off: about {gibBytes(lowOff.peakBytes)}
            {fitText(lowOff)}
          </p>
        )}
      </Row>
      {waiting && (
        <Row label="Graphics memory" hint={e ? `The engine's estimate for this clip (${e.width}×${e.height}, ${e.frames} frames)` : undefined}>
          <p className={`estimate ${cur?.fits === false ? "no-fit" : ""}`} role="status">
            {estimateText(est, cur, e)}
          </p>
        </Row>
      )}
    </>
  );
}

/** The estimate row's sentence: about X of Y free, and whether it fits (the engine's verdict, with its margin). */
function estimateText(est: MemoryEstimateResult | null, w: WindowEstimate | null, e: MemoryEstimate | null): string {
  if (!est) return "Asking the engine…";
  if (!est.ok) return est.reason;
  if (!w || !e) return "No estimate for this window.";
  const stale = est.stale ? " (free memory read before the queue started)" : "";
  const peak = `About ${gibBytes(w.peakBytes)}`;
  if (e.freeBytes === null || w.fits === null) return `${peak}; this system gives no memory reading, so no verdict.`;
  // the budget under a limit (the clip's, or the engine's CK_ENGINE_VRAM_BUDGET_GB): what the verdict is weighed against
  const capped = e.budgetBytes !== null && e.budgetBytes < e.freeBytes ? ` (${e.capGb !== null ? `the limit: ${gibBytes(e.budgetBytes)}` : `the engine's budget: ${gibBytes(e.budgetBytes)}`})` : "";
  const card = e.totalBytes !== null ? ` on this ${gibBytes(e.totalBytes)} card` : "";
  const of = `${peak} of ${gibBytes(e.freeBytes)} free${card}${capped}${stale}`;
  return w.fits ? `${of}: fits.` : `${of}: doesn't fit (with the engine's safety margin it needs ${gibBytes(w.needsBytes)}).`;
}

function FilePick({ path, onPick, onClear }: { path: string | null; onPick: () => void; onClear: () => void }) {
  return (
    <div className="file-pick">
      <button type="button" className="btn small" onClick={onPick}>
        <FolderOpen size={14} /> Choose…
      </button>
      {path && (
        <>
          <PathText path={path} />
          <button type="button" className="icon-btn" aria-label="Clear" title="Clear" onClick={onClear}>
            <X size={14} />
          </button>
        </>
      )}
    </div>
  );
}
