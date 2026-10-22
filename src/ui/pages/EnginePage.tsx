// Engine: what runs the model. Main view: which engine the queue uses, the
// engine as it last answered, each engine's files, the graphics card (read
// only while a job runs). Panel: where the ONNX Runtime engine and its models
// live, and the CorridorKey checkout the PyTorch engine runs from (kept until
// the ONNX engine replaces it; more when the in-app install lands, BACKLOG row 2).
import { Check, Cpu, FolderOpen, FolderCog, X } from "lucide-react";
import type { AppState } from "../../shared/types";
import { Accordion, Row, Section } from "../panel/Section";
import { MainBlock, SplitView } from "../panel/SplitView";
import { Stat } from "../JobView";
import { gb } from "../format";

export function EnginePage(props: { state: AppState; panelShown: boolean; narrow: boolean; glass: boolean; focus: string | null; sectionTasks: Record<string, string>; hidePanel: () => void }) {
  const { state } = props;
  const p = state.engine.pong;
  const root = state.settings.corridorKeyRoot;
  const st = state.settings;
  const kind = state.engineKind;
  const rust = state.rustEngine;
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
  const pick = (what: "binary" | "models" | "ort", label: string, value: string | null, hint: string) => (
    <Row label={label} hint={hint}>
      <div className="file-pick">
        <button type="button" className="btn small" onClick={() => window.ck.pickRustEngine(what)}>
          <FolderOpen size={14} /> Choose…
        </button>
        {value && (
          <span className="path" title={value}>
            {value}
          </span>
        )}
      </div>
    </Row>
  );

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
                : "None set up yet: choose the engine program and its models folder in the panel."}
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
          {st.engineBinary && (
            <div className="path" style={{ marginBottom: 4 }}>
              {st.engineBinary}
            </div>
          )}
          {st.modelsDir && (
            <div className="path" style={{ marginBottom: 8 }}>
              {st.modelsDir}
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
      <Section id="onnx" icon={Cpu} title="ONNX Runtime engine" status={rust.ok ? (kind === "rust" ? "in use" : "set up") : "not set up"} task={props.sectionTasks["engine/onnx"] ?? null}>
        {() => (
          <>
            {pick("binary", "Engine program", st.engineBinary, "corridorkey-engine, built from engine-rs/")}
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
