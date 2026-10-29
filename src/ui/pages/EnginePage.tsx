// Engine: what runs the model. Main view: whether the engine is set up, the
// engine as it last answered, its files, the graphics card (read
// only while a job runs). Panel: the first-run install (GPU runtime and models),
// ffmpeg (checked, and installed on request), and the lists of engine files found
// (Automatic = the newest, Browse… for anything else).
import { Check, Cpu, Download, Film, FolderOpen, ListChecks, X, Zap } from "lucide-react";
import type { AppState, EngineFileKind } from "../../shared/types";
import { installMissing } from "../../shared/tasks";
import { downloadingStatus, ENGINE_FAILED, NO_VRAM_HELD } from "../../shared/texts";
import { Accordion, Row, Section, type SectionFocus } from "../panel/Section";
import { MainBlock, SplitView } from "../panel/SplitView";
import { Stat } from "../JobView";
import { gbBytes, gib } from "../format";
import { buildSteps } from "../../shared/trt";
import { FfmpegBox, InstallBox, installPct, TrtBox } from "../setup/SetupParts";
import { PathText } from "../PathText";
import { ProgressBar } from "../ProgressBar";
import type { CSSProperties } from "react";

/** NorthXL's heat (Card/Bar: a reading warms toward red as it rises), as a share 0–1 the theme's tokens mix by. */
function heatStyle(ratio: number): CSSProperties {
  return { "--heat": `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%` } as CSSProperties;
}

/** NorthXL's Bar: the label left, the value right, the bar under them (the app's one progress bar). */
function GpuBar({ label, text, value, max, heat }: { label: string; text: string; value: number; max: number; heat?: number }) {
  return (
    <div className={`gpu-bar${heat === undefined ? "" : " heat"}`} style={heat === undefined ? undefined : heatStyle(heat)}>
      <div className="gpu-bar-head">
        <span>{label}</span>
        <span className="gpu-bar-value">{text}</span>
      </div>
      <ProgressBar label={label} value={value} max={max} />
    </div>
  );
}

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
  const steps = buildSteps(trt.prebuild.ranges);
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
            ? `on · building: ${steps.done} of ${steps.total} networks done`
            : trt.prebuild.status === "paused"
              ? "on · build paused while keying"
              : trt.prebuild.status === "done"
                ? builtFor
                  ? `on · built for ${builtFor}`
                  : "on · no sizes chosen: clips run on CUDA"
                : "on · not built yet: clips run on CUDA";
  // the readout shows only while a job runs (rule 11): the last reading isn't kept on screen after the queue ends
  const g = state.queueRunning ? state.gpu : null;
  // NorthXL's row, in its order; the temperature takes its heat tint (40 °C cool to 90 °C hot, as NorthXL)
  const readings: { k: string; text: string; heat?: number }[] = [];
  if (g?.tempC !== undefined) readings.push({ k: "temp", text: `${Math.round(g.tempC)} °C`, heat: (g.tempC - 40) / 50 });
  if (g?.fanPct !== undefined) readings.push({ k: "fan", text: `Fan ${Math.round(g.fanPct)}%` });
  if (g?.clockMhz !== undefined) readings.push({ k: "clock", text: `${Math.round(g.clockMhz)} MHz` });
  if (g?.powerW !== undefined) readings.push({ k: "power", text: `${Math.round(g.powerW)} W` });
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
  // A list of what was found (newest first), Automatic on top, Browse… beside it for anything else (Marcy 2026-10-23:
  // choose from a list, not only a file browser). Browse… is a button, not an option: arrowing through a closed list
  // fires a change per step, and must never open a file dialog (senior review S5). The path in use shows under it.
  const pick = (what: EngineFileKind, label: string, setting: string | null, hint: string) => {
    const found = state.engineFiles[what];
    const inUse = state.enginePaths[what];
    // loop: NOT-WORTH — one or two found copies per render
    const custom = setting && !found.some((f) => f.path === setting) ? setting : null;
    return (
      <Row label={label} hint={hint} htmlFor={`engine-${what}`}>
        <div className="file-pick stacked">
          <select id={`engine-${what}`} value={setting ?? ""} onChange={(e) => void window.ck.setRustEngine(what, e.target.value === "" ? null : e.target.value)}>
            <option value="">{found.length ? `Automatic: ${found[0].label}` : "Automatic: none found"}</option>
            {/* loop: NOT-WORTH — one or two found copies per list */}
            {found.map((f) => (
              <option key={f.path} value={f.path}>
                {f.label}
              </option>
            ))}
            {custom && <option value={custom}>{custom}</option>}
          </select>
          <button type="button" className="btn small" aria-label={`Browse for the ${label.toLowerCase()}`} onClick={() => void window.ck.pickRustEngine(what)}>
            <FolderOpen size={14} /> Browse…
          </button>
          {inUse && <PathText path={inUse} />}
        </div>
      </Row>
    );
  };

  // the model set (row 168): each one installed or its download; one not installed downloads with the setup's own download.
  // A single set (macOS: no onnx.4 Core ML set) is named as text, not offered as a one-choice list.
  const sets = inst.modelSets;
  // loop: NOT-WORTH — one or two sets per render
  const chosenSet = sets.find((x) => x.name === st.modelSet) ?? sets[0];
  // loop: NOT-WORTH — as above
  const setText = (x: (typeof sets)[number]) => `${x.name}${x === sets[0] ? " (default)" : ""} · ${x.installed ? "installed" : `${gbBytes(x.bytes)} download`}`;
  const chooseSet = (name: string) => {
    // loop: NOT-WORTH — as above
    const x = sets.find((y) => y.name === name);
    void window.ck.setModelSet(name).then(() => (x && !x.installed ? window.ck.startInstall() : undefined));
  };
  const downloading = inst.status === "running" || trt.status === "running";
  const modelSetRow = (
    <Row
      label="Model set"
      hint={
        sets.length > 1 ? "Which version of the CorridorKey models the engine runs. One not on this computer yet downloads when you pick it." : "The version of the CorridorKey models the engine runs."
      }
      htmlFor={sets.length > 1 ? "engine-model-set" : undefined}
    >
      {sets.length > 1 ? (
        <select id="engine-model-set" value={chosenSet.name} disabled={downloading} onChange={(e) => chooseSet(e.target.value)}>
          {/* loop: NOT-WORTH — two sets per list */}
          {sets.map((x) => (
            <option key={x.name} value={x.name}>
              {setText(x)}
            </option>
          ))}
        </select>
      ) : (
        <span>{setText(chosenSet)}</span>
      )}
    </Row>
  );

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
              {/* what the engine didn't report is left out, never shown as "?" (senior review N5) */}
              {/* loop: NOT-WORTH — three parts per render */}
              <Stat k="Runtime" v={[`ONNX Runtime${p.ort ? ` ${p.ort}` : " (version not reported)"}`, p.provider, p.precision].filter(Boolean).join(" · ")} />
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
                  {ok ? <Check size={15} aria-hidden /> : <X size={15} aria-hidden />} {k} {ok ? `found by the engine${p.precision ? ` (${p.precision})` : ""}` : "missing"}
                </li>
              ))}
            </ul>
          )}
        </MainBlock>
        {/* NorthXL's GPU card (backlog row 171): its order — the card in the header, Usage and memory as bars, then
            temperature, fan, clock and power; a reading the card doesn't give is left out, never a 0 */}
        <MainBlock title={g ? `Graphics card · ${g.name}` : "Graphics card"}>
          {g ? (
            <div className="gpu-card">
              <GpuBar label="Usage" text={`${g.utilization}%`} value={g.utilization} max={100} heat={g.utilization / 100} />
              <GpuBar label="Memory" text={`${gib(g.usedMb)} / ${gib(g.totalMb)}`} value={g.usedMb} max={g.totalMb} />
              {readings.length > 0 && (
                <div className="gpu-readings">
                  {/* loop: NOT-WORTH — up to four readings per render */}
                  {readings.map((r) => (
                    <span key={r.k} data-testid="gpu-reading" className={r.heat === undefined ? undefined : "heat"} style={r.heat === undefined ? undefined : heatStyle(r.heat)}>
                      {r.text}
                    </span>
                  ))}
                </div>
              )}
              <ul className="gpu-procs">
                {/* loop: HOT-PATH-OK — a few compute processes per render (GPU readout every 2 s while a job runs) */}
                {g.processes.map((pr) => (
                  <li key={pr.pid}>
                    {pr.ours ? "CorridorKey engine" : pr.name} — {gib(pr.usedMb)}
                  </li>
                ))}
              </ul>
            </div>
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
            {modelSetRow}
            {pick("models", "Models folder", st.modelsDir, "The five CorridorKey ONNX networks (C-RADIO, MoGe, RVM, stage 1, stage 2)")}
            {pick("ort", "ONNX Runtime library", st.ortLibrary, `${state.system.ortLib}, the graphics card build`)}
          </>
        )}
      </Section>
    </Accordion>
  );

  return <SplitView main={main} panel={panel} panelTitle="Engine settings" shown={props.panelShown} narrow={props.narrow} glass={props.glass} onEscape={props.hidePanel} />;
}
