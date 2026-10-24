// Engine: what runs the model. Main view: which engine the queue uses, the
// engine as it last answered, each engine's files, the graphics card (read
// only while a job runs). Panel: the first-run install (GPU runtime and models),
// ffmpeg (checked, and installed on request), the lists of engine files found
// (Automatic = the newest, Browse… for anything else), and the CorridorKey
// checkout the PyTorch engine (the benchmark reference) runs from.
import { Check, Cpu, Download, Film, FolderOpen, FolderCog, ListChecks, X, Zap } from "lucide-react";
import type { AppState } from "../../shared/types";
import { installMissing } from "../../shared/tasks";
import { downloadingStatus, ENGINE_FAILED, NO_VRAM_HELD } from "../../shared/texts";
import { Accordion, Row, Section } from "../panel/Section";
import { MainBlock, SplitView } from "../panel/SplitView";
import { Stat } from "../JobView";
import { gib } from "../format";
import { FfmpegBox, InstallBox, installPct, TrtBox } from "../setup/SetupParts";

export function EnginePage(props: {
  state: AppState;
  panelShown: boolean;
  narrow: boolean;
  glass: boolean;
  focus: string | null;
  sectionTasks: Record<string, string>;
  hidePanel: () => void;
  openSetup: () => void;
}) {
  const { state } = props;
  const p = state.engine.pong;
  const root = state.settings.corridorKeyRoot;
  const st = state.settings;
  const kind = state.engineKind;
  const rust = state.rustEngine;
  const ff = state.ffmpeg;
  const inst = state.install;
  const needInstall = installMissing(inst);
  const pct = installPct(inst);
  const trt = state.tensorrt;
  const trtStatus = !trt.supported
    ? state.system.platform === "darwin"
      ? "not on Macs"
      : "Linux only in this version"
    : trt.status === "running"
      ? downloadingStatus(installPct(trt))
      : !trt.on
        ? "off"
        : trt.ready
          ? "on"
          : "on · not installed yet";
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
          <section className="notice error">
            <h3>{ENGINE_FAILED}</h3>
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
                  ? "Not installed yet: the setup downloads the GPU runtime and the models."
                  : "None set up yet: no engine program or models found. Choose them in the panel."}
          </p>
          <button type="button" className="btn small" onClick={props.openSetup}>
            <ListChecks size={14} /> Open the setup
          </button>
        </MainBlock>
        <MainBlock title="Engine">
          {p ? (
            <div className="stats">
              <Stat k="State" v={{ stopped: `Idle · ${NO_VRAM_HELD}`, starting: "Starting", ready: "Running the queue", failed: "Failed" }[state.engine.status]} />
              <Stat k="Engine" v={`${p.engine} ${p.version} · protocol ${p.protocol}`} />
              {p.torch ? <Stat k="Python / PyTorch" v={`${p.python ?? "?"} · ${p.torch}`} /> : <Stat k="Runtime" v={`ONNX Runtime ${p.ort ?? "?"} · ${p.provider ?? "?"} · ${p.precision ?? "?"}`} />}
              <Stat k="Graphics card" v={p.gpu ? `${p.gpu}${p.vramTotalMb ? ` · ${gib(p.vramTotalMb)}` : ""}` : "none found"} />
              {trt.supported && !p.torch && <Stat k="TensorRT" v={trt.on ? (trt.ready ? "On: jobs ask for it" : "On, not installed: jobs run on CUDA") : "Off"} />}
            </div>
          ) : (
            <p className="hint-text">Not started yet this session. It starts with the queue and quits when the queue is done, so it holds no graphics memory while idle.</p>
          )}
        </MainBlock>
        <MainBlock title="ONNX Runtime engine files">
          {/* before the first install nothing is wrong yet: the setup installs them (no red "missing" lines) */}
          {needInstall && !rust.ok ? <p className="hint-text">The setup's first step installs them.</p> : checks(rust, "Engine program and the five networks found")}
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
        <MainBlock title="Graphics card">
          {state.gpu && state.queueRunning ? (
            <>
              <div className="stats">
                <Stat k="Card" v={state.gpu.name} />
                <Stat k="Memory used" v={`${gib(state.gpu.usedMb)} / ${gib(state.gpu.totalMb)}`} />
                <Stat k="Busy" v={`${state.gpu.utilization}%`} />
              </div>
              <ul className="gpu-procs">
                {/* loop: HOT-PATH-OK — a few compute processes per render (GPU readout every 2 s while a job runs) */}
                {state.gpu.processes.map((g) => (
                  <li key={g.pid}>
                    {g.ours ? "CorridorKey engine" : g.name} — {gib(g.usedMb)}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="hint-text">Read while a job runs and this window is shown (nothing is read while idle).</p>
          )}
          {state.gpuError && <p className="hint-text">Graphics card readout: {state.gpuError}</p>}
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
        status={inst.status === "running" ? downloadingStatus(pct) : needInstall ? "not installed" : "installed"}
        task={props.sectionTasks["engine/install"] ?? null}
      >
        {() => <InstallBox inst={inst} />}
      </Section>
      <Section id="tensorrt" icon={Zap} title="TensorRT" status={trtStatus} task={props.sectionTasks["engine/tensorrt"] ?? null}>
        {() => <TrtBox trt={trt} inst={inst} platform={state.system.platform} />}
      </Section>
      <Section
        id="ffmpeg"
        icon={Film}
        title="ffmpeg"
        status={!ff.checked ? "checking…" : ff.ok ? "installed" : ff.installing ? "installing…" : "not installed"}
        task={props.sectionTasks["engine/ffmpeg"] ?? null}
      >
        {() => <FfmpegBox ff={ff} />}
      </Section>
      <Section id="onnx" icon={Cpu} title="ONNX Runtime engine" status={rust.ok ? (kind === "rust" ? "in use" : "set up") : "not set up"} task={props.sectionTasks["engine/onnx"] ?? null}>
        {() => (
          <>
            {pick("binary", "Engine program", st.engineBinary, state.system.engineBin)}
            {pick("models", "Models folder", st.modelsDir, "The five CorridorKey ONNX networks (C-RADIO, MoGe, RVM, stage 1, stage 2)")}
            {pick("ort", "ONNX Runtime library", st.ortLibrary, `${state.system.ortLib}, the graphics card build`)}
          </>
        )}
      </Section>
      <Section id="folder" icon={FolderCog} title="Benchmark reference (advanced)" status={root ? (state.checkout.ok ? "set up" : "incomplete") : "not used"} task={null}>
        {() => (
          <>
            <p className="hint-text">
              Not needed to use CorridorKey. It runs Corridor's original CorridorKey 2.0 (PyTorch) from a CorridorKey2.0 checkout, so speed and quality can be compared on the same machine (README,
              Speed).
            </p>
            <Row label="CorridorKey2.0 checkout" hint="The original's folder, with its venv and weights">
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
            {root &&
              (state.checkout.ok ? (
                <div className="check-line ok">
                  <Check size={15} aria-hidden /> Code, Python environment, weights and foundation models found
                </div>
              ) : (
                <ul className="check-list">
                  {/* loop: NOT-WORTH — a few problems per render */}
                  {state.checkout.problems.map((m) => (
                    <li key={m} className="hint-text">
                      Not usable yet: {m}
                    </li>
                  ))}
                </ul>
              ))}
          </>
        )}
      </Section>
    </Accordion>
  );

  return <SplitView main={main} panel={panel} panelTitle="Engine settings" shown={props.panelShown} narrow={props.narrow} glass={props.glass} onEscape={props.hidePanel} />;
}
