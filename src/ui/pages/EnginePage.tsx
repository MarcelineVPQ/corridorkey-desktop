// Engine: what runs the model. Main view: whether the engine is set up, the
// engine as it last answered, its files, the graphics card (read
// only while a job runs). Panel: the first-run install (GPU runtime and models),
// ffmpeg (checked, and installed on request), and the lists of engine files found
// (Automatic = the newest, Browse… for anything else).
import { Check, Cpu, Download, Film, ListChecks, X, Zap } from "lucide-react";
import type { AppState, EngineFileKind } from "../../shared/types";
import { installMissing } from "../../shared/tasks";
import { downloadingStatus, ENGINE_FAILED, NO_VRAM_HELD } from "../../shared/texts";
import { Accordion, Row, Section, type SectionFocus } from "../panel/Section";
import { MainBlock, SplitView } from "../panel/SplitView";
import { Stat } from "../JobView";
import { gib } from "../format";
import { FfmpegBox, InstallBox, installPct, TrtBox } from "../setup/SetupParts";
import { PathText } from "../PathText";

export function EnginePage(props: {
  state: AppState;
  panelShown: boolean;
  narrow: boolean;
  glass: boolean;
  focus: SectionFocus;
  sectionTasks: Record<string, string>;
  hidePanel: () => void;
  openSetup: () => void;
}) {
  const { state } = props;
  const p = state.engine.pong;
  const st = state.settings;
  const rust = state.rustEngine;
  const ff = state.ffmpeg;
  const inst = state.install;
  const needInstall = installMissing(inst);
  const pct = installPct(inst);
  const trt = state.tensorrt;
  // loop: NOT-WORTH — the few chosen sizes, per render
  const builtFor = trt.prebuild.ranges.map((r) => r.label).join(", ");
  const trtStatus = !trt.supported
    ? state.system.platform === "darwin"
      ? "not on Macs"
      : "Linux only in this version"
    : trt.status === "running"
      ? downloadingStatus(installPct(trt))
      : !trt.on
        ? "off"
        : !trt.ready
          ? "on · not installed yet"
          : trt.prebuild.status === "running"
            ? `on · building ${Math.floor(trt.prebuild.fraction * 100)} %`
            : trt.prebuild.status === "paused"
              ? "on · build paused while keying"
              : trt.prebuild.status === "done"
                ? builtFor
                  ? `on · built for ${builtFor}`
                  : "on · no sizes chosen: clips run on CUDA"
                : "on · not built yet: clips run on CUDA";
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
  const pick = (what: EngineFileKind, label: string, setting: string | null, hint: string) => {
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
          {inUse && <PathText path={inUse} />}
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
            {rust.ok
              ? "The CorridorKey engine on ONNX Runtime."
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
              <Stat k="Runtime" v={`ONNX Runtime ${p.ort ?? "?"} · ${p.provider ?? "?"} · ${p.precision ?? "?"}`} />
              <Stat k="Graphics card" v={p.gpu ? `${p.gpu}${p.vramTotalMb ? ` · ${gib(p.vramTotalMb)}` : ""}` : "none found"} />
              {trt.supported && <Stat k="TensorRT" v={trt.on ? (trt.ready ? "On: jobs ask for it" : "On, not installed: jobs run on CUDA") : "Off"} />}
            </div>
          ) : (
            <p className="hint-text">Not started yet this session. It starts with the queue and quits when the queue is done, so it holds no graphics memory while idle.</p>
          )}
        </MainBlock>
        <MainBlock title="ONNX Runtime engine files">
          {/* before the first install nothing is wrong yet: the setup installs them (no red "missing" lines) */}
          {needInstall && !rust.ok ? <p className="hint-text">The setup's first step installs them.</p> : checks(rust, "Engine program and the five networks found")}
          {p && (
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
      <Section id="onnx" icon={Cpu} title="ONNX Runtime engine" status={rust.ok ? "in use" : "not set up"} task={props.sectionTasks["engine/onnx"] ?? null}>
        {() => (
          <>
            {pick("binary", "Engine program", st.engineBinary, state.system.engineBin)}
            {pick("models", "Models folder", st.modelsDir, "The five CorridorKey ONNX networks (C-RADIO, MoGe, RVM, stage 1, stage 2)")}
            {pick("ort", "ONNX Runtime library", st.ortLibrary, `${state.system.ortLib}, the graphics card build`)}
          </>
        )}
      </Section>
    </Accordion>
  );

  return <SplitView main={main} panel={panel} panelTitle="Engine settings" shown={props.panelShown} narrow={props.narrow} glass={props.glass} onEscape={props.hidePanel} />;
}
