// Engine: what runs the model. Main view: which engine the queue uses, the
// engine as it last answered, each engine's files, the graphics card (read
// only while a job runs). Panel: the first-run install (GPU runtime and models),
// ffmpeg (checked, and installed on request), the lists of engine files found
// (Automatic = the newest, Browse… for anything else), and the CorridorKey
// checkout the PyTorch engine (the benchmark reference) runs from.
import { Check, Cpu, Download, Film, FolderOpen, FolderCog, X } from "lucide-react";
import type { AppState } from "../../shared/types";
import { Accordion, Row, Section } from "../panel/Section";
import { MainBlock, SplitView } from "../panel/SplitView";
import { Stat } from "../JobView";
import { gb, gbBytes } from "../format";

export function EnginePage(props: { state: AppState; panelShown: boolean; narrow: boolean; glass: boolean; focus: string | null; sectionTasks: Record<string, string>; hidePanel: () => void }) {
  const { state } = props;
  const p = state.engine.pong;
  const root = state.settings.corridorKeyRoot;
  const st = state.settings;
  const kind = state.engineKind;
  const rust = state.rustEngine;
  const ff = state.ffmpeg;
  const inst = state.install;
  const needInstall = inst.needRuntime || inst.needModels;
  const pct = inst.total ? Math.floor((inst.done / inst.total) * 100) : 0;
  const checks = (c: { ok: boolean; problems: string[] }, okText: string) =>
    c.ok ? (
      <div className="check-line ok">
        <Check size={15} aria-hidden /> {okText}
      </div>
    ) : (
      <ul className="check-list">
        {/* loop: NOT-WORTH — a few problems per render */}
        {c.problems.map((m) => (
          <li key={m} className="check-line error">
            <X size={15} aria-hidden /> {m}
          </li>
        ))}
      </ul>
    );
  // A list of what was found (newest first), Automatic on top, Browse… for anything else (Marcy 2026-10-23:
  // choose from a list, not only a file browser). The path in use shows under it.
  const BROWSE = "::browse";
  const pick = (what: "binary" | "models" | "ort", label: string, setting: string | null, hint: string) => {
    const found = state.engineFiles[what];
    const inUse = state.enginePaths[what];
    // loop: NOT-WORTH — one or two found copies per render
    const custom = setting && !found.some((f) => f.path === setting) ? setting : null;
    return (
      <Row label={label} hint={hint} htmlFor={`engine-${what}`}>
        <div className="file-pick stacked">
          <select
            id={`engine-${what}`}
            value={setting ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              if (v === BROWSE) void window.ck.pickRustEngine(what);
              else void window.ck.setRustEngine(what, v === "" ? null : v);
            }}
          >
            <option value="">{found.length ? `Automatic: ${found[0].label}` : "Automatic: none found"}</option>
            {/* loop: NOT-WORTH — one or two found copies per list */}
            {found.map((f) => (
              <option key={f.path} value={f.path}>
                {f.label}
              </option>
            ))}
            {custom && <option value={custom}>{custom}</option>}
            <option value={BROWSE}>Browse…</option>
          </select>
          {inUse && (
            <span className="path" title={inUse}>
              {inUse}
            </span>
          )}
        </div>
      </Row>
    );
  };

  const main = (
    <div className="page-body">
      <div className="page-bar">
        <h1>Engine</h1>
      </div>
      <div className="page-content">
        {state.engine.status === "failed" && (
          <section className="notice error" style={{ margin: "0 0 14px" }}>
            <h3>The engine didn't start</h3>
            <div>{state.engine.error}</div>
          </section>
        )}
        <MainBlock title="Engine in use">
          <p className="hint-text">
            {kind === "rust"
              ? "The CorridorKey engine on ONNX Runtime."
              : kind === "python"
                ? "The PyTorch engine from your CorridorKey2.0 folder. Set up the ONNX Runtime engine to use it instead."
                : needInstall
                  ? "Not installed yet: press Download and install under Runtime and models in the panel."
                  : "None set up yet: no engine program or models found. Choose them in the panel."}
          </p>
        </MainBlock>
        <MainBlock title="Engine">
          {p ? (
            <div className="stats">
              <Stat k="State" v={{ stopped: "Idle · no graphics memory held", starting: "Starting", ready: "Running the queue", failed: "Failed" }[state.engine.status]} />
              <Stat k="Engine" v={`${p.engine} ${p.version} · protocol ${p.protocol}`} />
              {p.torch ? <Stat k="Python / PyTorch" v={`${p.python ?? "?"} · ${p.torch}`} /> : <Stat k="Runtime" v={`ONNX Runtime ${p.ort ?? "?"} · ${p.provider ?? "?"} · ${p.precision ?? "?"}`} />}
              <Stat k="Graphics card" v={p.gpu ? `${p.gpu}${p.vramTotalMb ? ` · ${gb(p.vramTotalMb)}` : ""}` : "none found"} />
            </div>
          ) : (
            <p className="hint-text">Not started yet this session. It starts with the queue and quits when the queue is done, so it holds no graphics memory while idle.</p>
          )}
        </MainBlock>
        <MainBlock title="ONNX Runtime engine files">
          {state.enginePaths.binary && (
            <div className="path" style={{ marginBottom: 4 }}>
              {state.enginePaths.binary}
            </div>
          )}
          {state.enginePaths.models && (
            <div className="path" style={{ marginBottom: 8 }}>
              {state.enginePaths.models}
            </div>
          )}
          {checks(rust, "Engine program and the five networks found")}
          {p && !p.torch && (
            <ul className="check-list">
              {/* loop: NOT-WORTH — five networks per render */}
              {Object.entries(p.assets).map(([k, ok]) => (
                <li key={k} className={`check-line ${ok ? "ok" : "error"}`}>
                  {ok ? <Check size={15} aria-hidden /> : <X size={15} aria-hidden />} {k} {ok ? `found by the engine (${p.precision ?? ""})` : "missing"}
                </li>
              ))}
            </ul>
          )}
        </MainBlock>
        <MainBlock title="CorridorKey files (PyTorch engine)">
          {root ? (
            <>
              <div className="path" style={{ marginBottom: 8 }}>
                {root}
              </div>
              {checks(state.checkout, "Code, Python environment, weights and foundation models found")}
              {p && p.torch && (
                <ul className="check-list">
                  {/* loop: NOT-WORTH — five networks per render */}
                  {Object.entries(p.assets).map(([k, ok]) => (
                    <li key={k} className={`check-line ${ok ? "ok" : "error"}`}>
                      {ok ? <Check size={15} aria-hidden /> : <X size={15} aria-hidden />} {k.replace("_", " ")} {ok ? "found by the engine" : "missing"}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="hint-text">No CorridorKey folder chosen yet.</p>
          )}
        </MainBlock>
        <MainBlock title="Graphics card">
          {state.gpu && state.queueRunning ? (
            <>
              <div className="stats">
                <Stat k="Card" v={state.gpu.name} />
                <Stat k="Memory used" v={`${gb(state.gpu.usedMb)} / ${gb(state.gpu.totalMb)}`} />
                <Stat k="Busy" v={`${state.gpu.utilization}%`} />
              </div>
              <ul className="gpu-procs">
                {/* loop: HOT-PATH-OK — a few compute processes per render (GPU readout every 2 s while a job runs) */}
                {state.gpu.processes.map((g) => (
                  <li key={g.pid}>
                    {g.ours ? "CorridorKey engine" : g.name} — {gb(g.usedMb)}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="hint-text">Read while a job runs and this window is shown (nothing is read while idle).</p>
          )}
          {state.gpuError && <p className="hint-text">nvidia-smi: {state.gpuError}</p>}
        </MainBlock>
      </div>
    </div>
  );

  const panel = (
    <Accordion page="engine" focus={props.focus}>
      <Section
        id="install"
        icon={Download}
        title="Runtime and models"
        status={inst.status === "running" ? `downloading ${pct}%` : needInstall ? "not installed" : "installed"}
        task={props.sectionTasks["engine/install"] ?? null}
      >
        {() =>
          !needInstall ? (
            <div className="check-line ok">
              <Check size={15} aria-hidden /> The GPU runtime and the CorridorKey models are installed
            </div>
          ) : (
            <>
              <p className="hint-text">CorridorKey downloads what it runs on, once, into {inst.dir}:</p>
              <ul className="check-list">
                {inst.needRuntime && (
                  <li className="hint-text">
                    GPU runtime, {gbBytes(inst.runtimeBytes)} download: ONNX Runtime (Microsoft, MIT licence) and NVIDIA's CUDA and cuDNN libraries (NVIDIA licence), from pypi.org
                  </li>
                )}
                {inst.needModels && (
                  <li className="hint-text">
                    CorridorKey models, {gbBytes(inst.modelsBytes)} download: by Corridor Digital, under the CorridorKey licence (free to use, never sold), from this app's GitHub releases
                  </li>
                )}
              </ul>
              {!inst.nvidia && <p className="hint-text">No NVIDIA graphics driver is loaded. CorridorKey Desktop runs on NVIDIA graphics cards.</p>}
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
                <button type="button" className="btn small" disabled={!inst.nvidia} onClick={() => void window.ck.startInstall()}>
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
          )
        }
      </Section>
      <Section
        id="ffmpeg"
        icon={Film}
        title="ffmpeg"
        status={!ff.checked ? "checking…" : ff.ok ? "installed" : ff.installing ? "installing…" : "not installed"}
        task={props.sectionTasks["engine/ffmpeg"] ?? null}
      >
        {() =>
          !ff.checked ? (
            <p className="hint-text">Checking ffmpeg…</p>
          ) : ff.ok ? (
            <div className="check-line ok">
              <Check size={15} aria-hidden /> ffmpeg and ffprobe found, with the H.264 and ProRes 4444 encoders
            </div>
          ) : (
            <>
              <p className="hint-text">CorridorKey reads and writes video with ffmpeg. {ff.problem}.</p>
              {ff.note && <p className="hint-text">{ff.note}</p>}
              <Row label="Install command" hint={ff.canInstall ? "The app runs it for you; your desktop asks for your password" : "Run it in a terminal"}>
                <div className="path selectable">{ff.command}</div>
              </Row>
              {ff.canInstall && (
                <button type="button" className="btn small" disabled={ff.installing} onClick={() => void window.ck.installFfmpeg()}>
                  {ff.installing ? "Installing…" : "Install ffmpeg"}
                </button>
              )}
              {ff.installError && (
                <div className="check-line error">
                  <X size={15} aria-hidden /> {ff.installError}
                </div>
              )}
            </>
          )
        }
      </Section>
      <Section id="onnx" icon={Cpu} title="ONNX Runtime engine" status={rust.ok ? (kind === "rust" ? "in use" : "set up") : "not set up"} task={props.sectionTasks["engine/onnx"] ?? null}>
        {() => (
          <>
            {pick("binary", "Engine program", st.engineBinary, "corridorkey-engine")}
            {pick("models", "Models folder", st.modelsDir, "The five CorridorKey ONNX networks (C-RADIO, MoGe, RVM, stage 1, stage 2)")}
            {pick("ort", "ONNX Runtime library", st.ortLibrary, "libonnxruntime.so with the CUDA provider, for the graphics card build")}
          </>
        )}
      </Section>
      <Section id="folder" icon={FolderCog} title="CorridorKey folder" status={root ? (state.checkout.ok ? root : "incomplete") : "not chosen"} task={props.sectionTasks["engine/folder"] ?? null}>
        {() => (
          <Row label="Folder" hint="The CorridorKey2.0 checkout with its venv and weights (the PyTorch engine)">
            <div className="file-pick">
              <button type="button" className="btn small" onClick={() => window.ck.pickCheckout()}>
                <FolderOpen size={14} /> Choose…
              </button>
              {root && (
                <span className="path" title={root}>
                  {root}
                </span>
              )}
            </div>
          </Row>
        )}
      </Section>
    </Accordion>
  );

  return <SplitView main={main} panel={panel} panelTitle="Engine settings" shown={props.panelShown} narrow={props.narrow} glass={props.glass} onEscape={props.hidePanel} />;
}
