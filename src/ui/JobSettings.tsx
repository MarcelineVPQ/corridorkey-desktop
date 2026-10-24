// The Queue page's panel: the selected clip's settings, one Section each.
// Every control maps to one engine option (docs/ENGINE_PROTOCOL.md) and
// changes what the run does (rule 4). Locked once the clip has run.
import { Clapperboard, Film, FolderOpen, MemoryStick, Wand2, X } from "lucide-react";
import type { Job, JobOptions, OutputName } from "../shared/types";
import { OUTPUT_NAMES } from "../shared/types";
import { AS_USED, lowerFirst } from "../shared/texts";
import { Accordion, Row, Section, Segmented } from "./panel/Section";

const OUTPUT_TEXT: Record<OutputName, { label: string; help: string }> = {
  alpha: { label: "Alpha", help: "the matte" },
  fg: { label: "Foreground", help: "the predicted foreground color" },
  checker: { label: "Checker", help: "foreground over a checkerboard, despilled" },
  cutout: { label: "Cutout", help: "straight color + alpha, despilled" },
};

const MATTE_HELP = "White = subject, black = background"; // theme-exempt: prose about the matte's values, not a color

const WINDOWS: [number, number][] = [
  [80, 40],
  [48, 24],
  [24, 12],
  [8, 4],
  [4, 2],
  [1, 1],
];

const HINT_TEXT = { none: "No hint", "first-frame": "First-frame matte", video: "Hint video" } as const;

export function JobSettings({ job, focus, sectionTasks, onChange }: { job: Job; focus: string | null; sectionTasks: Record<string, string>; onChange: (o: JobOptions) => void }) {
  const o = job.options;
  const set = (patch: Partial<JobOptions>) => onChange({ ...o, ...patch });
  const locked = job.status !== "waiting" ? lowerFirst(AS_USED) : null;
  const pick = async (kind: "hint-image" | "hint-video") => {
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
  const memStatus = o.memory.auto ? "Automatic · from free graphics memory" : `Manual · ${o.memory.hannChunk}/${o.memory.hannStride}${o.memory.lowVram ? " · low-memory" : ""}`;
  // loop: HOT-PATH-OK — ≤ four outputs per render
  const outStatus = `${o.outputs.map((x) => OUTPUT_TEXT[x].label).join(", ")} · ${o.outputFormat === "exr" ? `EXR ${o.exrDtype}` : "video"}`;

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
                {OUTPUT_NAMES.map((name) => (
                  <label key={name} title={OUTPUT_TEXT[name].help}>
                    <input type="checkbox" checked={o.outputs.includes(name)} onChange={() => toggleOutput(name)} />
                    {OUTPUT_TEXT[name].label}
                  </label>
                ))}
              </div>
            </Row>
            <Row label="Format" hint={o.outputFormat === "exr" ? "Scene-linear, unclamped HDR" : "Display-referred previews"}>
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
              <Row label="Cutout color">
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

      <Section id="memory" icon={MemoryStick} title="Graphics memory" status={memStatus} disabled={locked}>
        {() => (
          <>
            <Row label="Temporal window" hint={o.memory.auto ? "Largest that fits when the job starts" : undefined}>
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
            {!o.memory.auto && (
              <>
                <Row label="Window / stride" htmlFor="win">
                  <select
                    id="win"
                    value={`${o.memory.hannChunk}/${o.memory.hannStride}`}
                    onChange={(e) => {
                      // loop: NOT-WORTH — two numbers per window choice
                      const [c, s] = e.target.value.split("/").map(Number);
                      if (!o.memory.auto) set({ memory: { ...o.memory, hannChunk: c, hannStride: s } });
                    }}
                  >
                    {/* loop: HOT-PATH-OK — a few window choices per render */}
                    {WINDOWS.map(([c, s]) => (
                      <option key={c} value={`${c}/${s}`}>
                        {c} / {s}
                      </option>
                    ))}
                  </select>
                </Row>
                <Row label="Low-memory mode" hint="Less graphics memory, more disk, slower">
                  <label className="checks">
                    <input type="checkbox" checked={o.memory.lowVram} onChange={(e) => !o.memory.auto && set({ memory: { ...o.memory, lowVram: e.target.checked } })} />
                    Staged inference
                  </label>
                </Row>
              </>
            )}
          </>
        )}
      </Section>
    </Accordion>
  );
}

function FilePick({ path, onPick, onClear }: { path: string | null; onPick: () => void; onClear: () => void }) {
  return (
    <div className="file-pick">
      <button type="button" className="btn small" onClick={onPick}>
        <FolderOpen size={14} /> Choose…
      </button>
      {path && (
        <>
          <span className="path" title={path}>
            {path}
          </span>
          <button type="button" className="icon-btn" aria-label="Clear" onClick={onClear}>
            <X size={14} />
          </button>
        </>
      )}
    </div>
  );
}
