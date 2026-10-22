// Engine: what runs the model. Main view: the engine as it last answered,
// the CorridorKey folder's files, the graphics card (read only while a job
// runs). Panel: where CorridorKey lives (more sections when the in-app
// install lands, BACKLOG row 2).
import { Check, FolderOpen, FolderCog, X } from "lucide-react";
import type { AppState } from "../../shared/types";
import { Accordion, Row, Section } from "../panel/Section";
import { MainBlock, SplitView } from "../panel/SplitView";
import { Stat } from "../JobView";
import { gb } from "../format";

export function EnginePage(props: { state: AppState; panelShown: boolean; narrow: boolean; glass: boolean; focus: string | null; sectionTasks: Record<string, string>; hidePanel: () => void }) {
  const { state } = props;
  const p = state.engine.pong;
  const root = state.settings.corridorKeyRoot;

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
        <MainBlock title="Engine">
          {p ? (
            <div className="stats">
              <Stat k="State" v={{ stopped: "Idle · no graphics memory held", starting: "Starting", ready: "Running the queue", failed: "Failed" }[state.engine.status]} />
              <Stat k="Engine" v={`${p.engine} ${p.version} · protocol ${p.protocol}`} />
              <Stat k="Python / PyTorch" v={`${p.python} · ${p.torch}`} />
              <Stat k="Graphics card" v={p.gpu ? `${p.gpu}${p.vramTotalMb ? ` · ${gb(p.vramTotalMb)}` : ""}` : "none found"} />
            </div>
          ) : (
            <p className="hint-text">Not started yet this session. It starts with the queue and quits when the queue is done, so it holds no graphics memory while idle.</p>
          )}
        </MainBlock>
        <MainBlock title="CorridorKey files">
          {root ? (
            <>
              <div className="path" style={{ marginBottom: 8 }}>
                {root}
              </div>
              {state.checkout.ok ? (
                <div className="check-line ok">
                  <Check size={15} aria-hidden /> Code, Python environment, weights and foundation models found
                </div>
              ) : (
                <ul className="check-list">
                  {state.checkout.problems.map((m) => (
                    <li key={m} className="check-line error">
                      <X size={15} aria-hidden /> {m}
                    </li>
                  ))}
                </ul>
              )}
              {p && (
                <ul className="check-list">
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
      <Section id="folder" icon={FolderCog} title="CorridorKey folder" status={root ? (state.checkout.ok ? root : "incomplete") : "not chosen"} task={props.sectionTasks["engine/folder"] ?? null}>
        {() => (
          <Row label="Folder" hint="The CorridorKey2.0 checkout with its venv and weights">
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
