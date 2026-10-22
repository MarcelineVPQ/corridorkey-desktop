// Settings of a waiting job. Every control maps to one engine option
// (docs/ENGINE_PROTOCOL.md) and changes what the run does (rule 4).
import { FolderOpen, X } from "lucide-react";
import type { Job, JobOptions, OutputName } from "../shared/types";
import { OUTPUT_NAMES } from "../shared/types";

const OUTPUT_TEXT: Record<OutputName, { label: string; help: string }> = {
  alpha: { label: "Alpha", help: "the matte" },
  fg: { label: "Foreground", help: "the predicted foreground color" },
  checker: { label: "Checker", help: "foreground over a checkerboard, despilled" },
  cutout: { label: "Cutout", help: "straight color + alpha (ProRes 4444 / RGBA EXR), despilled" },
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

export function JobSettings({ job, onChange }: { job: Job; onChange: (o: JobOptions) => void }) {
  const o = job.options;
  const set = (patch: Partial<JobOptions>) => onChange({ ...o, ...patch });
  const pick = async (kind: "hint-image" | "hint-video") => {
    const path = await window.ck.pickFile(kind);
    if (path) set(kind === "hint-image" ? { hintFirstFrame: path, hintMode: "first-frame" } : { hintVideo: path, hintMode: "video" });
  };
  const toggleOutput = (name: OutputName) => {
    const has = o.outputs.includes(name);
    if (has && o.outputs.length === 1) return; // at least one output
    set({ outputs: has ? o.outputs.filter((x) => x !== name) : OUTPUT_NAMES.filter((x) => x === name || o.outputs.includes(x)) });
  };
  const despillUsed = o.outputs.includes("checker") || o.outputs.includes("cutout");

  return (
    <>
      <section className="section">
        <h3>Hint</h3>
        <div className="field">
          <span className="label">Mode</span>
          <div className="seg" role="radiogroup" aria-label="Hint mode">
            {(
              [
                ["none", "No hint"],
                ["first-frame", "First-frame matte"],
                ["video", "Hint video"],
              ] as const
            ).map(([mode, text]) => (
              <button key={mode} role="radio" aria-checked={o.hintMode === mode} className={o.hintMode === mode ? "on" : ""} onClick={() => set({ hintMode: mode })}>
                {text}
              </button>
            ))}
          </div>
        </div>
        {o.hintMode === "none" && <p className="hint-text">The model decides what the subject is. Fastest to set up; less control when several subjects are in shot.</p>}
        {o.hintMode === "first-frame" && (
          <div className="field">
            <span className="label">Matte image</span>
            <FilePick path={o.hintFirstFrame} empty={MATTE_HELP} onPick={() => pick("hint-image")} onClear={() => set({ hintFirstFrame: null })} />
          </div>
        )}
        {o.hintMode === "video" && (
          <div className="field">
            <span className="label">Hint video</span>
            <FilePick path={o.hintVideo} empty="A matte for every frame (video or frame folder)" onPick={() => pick("hint-video")} onClear={() => set({ hintVideo: null })} />
          </div>
        )}
        {o.hintMode !== "none" && (
          <>
            <div className="field">
              <label htmlFor="hq">Hint trust</label>
              <div>
                <div className="range">
                  <input id="hq" type="range" min={0.3} max={1} step={0.05} value={o.hintQuality} onChange={(e) => set({ hintQuality: Number(e.target.value) })} />
                  <output>{o.hintQuality.toFixed(2)}</output>
                </div>
                <div className="hint-text">0.95 an artist's matte · 0.75 a rough automatic one · 0.50 or less a loose scribble</div>
              </div>
            </div>
            <div className="field">
              <span className="label">Carry</span>
              <label className="checks">
                <input type="checkbox" checked={o.carryHint} onChange={(e) => set({ carryHint: e.target.checked })} />
                Carry the model's own matte forward between windows
              </label>
            </div>
          </>
        )}
      </section>

      <section className="section">
        <h3>Outputs</h3>
        <div className="checks">
          {OUTPUT_NAMES.map((name) => (
            <label key={name} title={OUTPUT_TEXT[name].help}>
              <input type="checkbox" checked={o.outputs.includes(name)} onChange={() => toggleOutput(name)} />
              {OUTPUT_TEXT[name].label}
            </label>
          ))}
        </div>
        <div className="field">
          <span className="label">Format</span>
          <div className="seg" role="radiogroup" aria-label="Output format">
            <button role="radio" aria-checked={o.outputFormat === "video"} className={o.outputFormat === "video" ? "on" : ""} onClick={() => set({ outputFormat: "video" })}>
              Video (preview, 10-bit)
            </button>
            <button role="radio" aria-checked={o.outputFormat === "exr"} className={o.outputFormat === "exr" ? "on" : ""} onClick={() => set({ outputFormat: "exr" })}>
              EXR sequence (HDR, linear)
            </button>
          </div>
        </div>
        {o.outputFormat === "exr" && (
          <div className="field">
            <label htmlFor="exr">EXR pixel type</label>
            <select id="exr" value={o.exrDtype} onChange={(e) => set({ exrDtype: e.target.value as "half" | "float" })}>
              <option value="half">half</option>
              <option value="float">float</option>
            </select>
          </div>
        )}
        {despillUsed && (
          <div className="field">
            <label htmlFor="ds">Despill</label>
            <div className="range">
              <input id="ds" type="range" min={0} max={1} step={0.05} value={o.despillStrength} onChange={(e) => set({ despillStrength: Number(e.target.value) })} />
              <output>{o.despillStrength.toFixed(2)}</output>
            </div>
          </div>
        )}
        {o.outputs.includes("cutout") && o.outputFormat === "video" && (
          <div className="field">
            <span className="label">Cutout color</span>
            <label className="checks">
              <input type="checkbox" checked={o.cutoutLinear} onChange={(e) => set({ cutoutLinear: e.target.checked })} />
              Scene-linear instead of sRGB
            </label>
          </div>
        )}
      </section>

      {job.clip.kind === "frames" && (
        <section className="section">
          <h3>Frame folder</h3>
          <div className="field">
            <label htmlFor="fps">Frame rate</label>
            <input id="fps" type="number" min={1} max={240} step={0.001} value={o.frameDirFps} onChange={(e) => set({ frameDirFps: Number(e.target.value) || 24 })} />
          </div>
          <div className="field">
            <span className="label">Color</span>
            <label className="checks">
              <input type="checkbox" checked={o.frameDirLinear} onChange={(e) => set({ frameDirLinear: e.target.checked })} />
              Frames are scene-linear (e.g. linear EXR plates)
            </label>
          </div>
        </section>
      )}

      <section className="section">
        <h3>Graphics memory</h3>
        <div className="field">
          <span className="label">Temporal window</span>
          <div className="seg" role="radiogroup" aria-label="Memory mode">
            <button role="radio" aria-checked={o.memory.auto} className={o.memory.auto ? "on" : ""} onClick={() => set({ memory: { auto: true } })}>
              Automatic
            </button>
            <button role="radio" aria-checked={!o.memory.auto} className={!o.memory.auto ? "on" : ""} onClick={() => set({ memory: { auto: false, hannChunk: 24, hannStride: 12, lowVram: false } })}>
              Manual
            </button>
          </div>
        </div>
        {o.memory.auto ? (
          <p className="hint-text">The largest window that fits the free graphics memory when the job starts. The window it picks is shown while it runs.</p>
        ) : (
          <>
            <div className="field">
              <label htmlFor="win">Window / stride</label>
              <select
                id="win"
                value={`${o.memory.hannChunk}/${o.memory.hannStride}`}
                onChange={(e) => {
                  const [c, s] = e.target.value.split("/").map(Number);
                  if (!o.memory.auto) set({ memory: { ...o.memory, hannChunk: c, hannStride: s } });
                }}
              >
                {WINDOWS.map(([c, s]) => (
                  <option key={c} value={`${c}/${s}`}>
                    {c} / {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <span className="label">Low-memory mode</span>
              <label className="checks">
                <input type="checkbox" checked={o.memory.lowVram} onChange={(e) => !o.memory.auto && set({ memory: { ...o.memory, lowVram: e.target.checked } })} />
                Staged inference: less graphics memory, more disk, usually slower
              </label>
            </div>
          </>
        )}
      </section>
    </>
  );
}

function FilePick({ path, empty, onPick, onClear }: { path: string | null; empty: string; onPick: () => void; onClear: () => void }) {
  return (
    <div className="file-pick">
      <button className="btn small" onClick={onPick}>
        <FolderOpen size={14} /> Choose…
      </button>
      {path ? (
        <>
          <span className="path" title={path}>
            {path}
          </span>
          <button className="icon-btn" aria-label="Clear" onClick={onClear}>
            <X size={14} />
          </button>
        </>
      ) : (
        <span className="hint-text">{empty}</span>
      )}
    </div>
  );
}
