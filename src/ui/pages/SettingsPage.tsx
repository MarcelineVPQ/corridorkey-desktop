// App settings: this PC's choices, saved as you change them (no save bar).
// Main view: what they add up to (readouts). Panel: Appearance, Results,
// Updates. Every control changes something you can see (rule 4).
import { Download, FolderOpen, FolderOutput, Palette, RefreshCw, RotateCcw } from "lucide-react";
import type { Appearance, AppState, UpdateState } from "../../shared/types";
import { Accordion, Row, Section, Segmented } from "../panel/Section";
import { MainBlock, SplitView } from "../panel/SplitView";
import { Stat } from "../JobView";

const THEME_TEXT = { system: "System", light: "Light", dark: "Dark", desktop: "Desktop" } as const;

export function SettingsPage(props: { state: AppState; panelShown: boolean; narrow: boolean; glass: boolean; focus: string | null; hidePanel: () => void }) {
  const { state } = props;
  const a = state.settings.appearance;
  const setA = (patch: Partial<Appearance>) => void window.ck.setAppearance({ ...a, ...patch });
  const needsDesktop = a.theme === "desktop" || a.accent === "desktop";
  const desktopRead = state.desktopPalette;
  const desktopNote = !needsDesktop
    ? null
    : desktopRead
      ? desktopRead.source === "kde"
        ? "Your KDE color scheme"
        : "Your desktop's accent color"
      : "The desktop's colors couldn't be read; the built-in theme is used";
  const u = state.update;

  const main = (
    <div className="page-body">
      <div className="page-bar">
        <h1>App settings</h1>
      </div>
      <div className="page-content">
        <MainBlock title="This PC">
          <div className="stats">
            <Stat k="Theme" v={`${THEME_TEXT[a.theme]}${a.glass ? " · Glass" : ""}`} />
            <Stat k="Accent" v={a.accent === "desktop" ? "Desktop's accent" : "CorridorKey green"} />
            <Stat k="Results go" v={state.settings.outputRoot ? "Into one folder" : "Next to each clip"} />
            <Stat k="Version" v={versionText(state.version)} />
          </div>
          {desktopNote && <p className="hint-text">{desktopNote}</p>}
          {state.settings.outputRoot && <div className="path">{state.settings.outputRoot}</div>}
        </MainBlock>
      </div>
    </div>
  );

  const panel = (
    <Accordion page="settings" focus={props.focus}>
      <Section id="appearance" icon={Palette} title="Appearance" status={`${THEME_TEXT[a.theme]} · ${a.accent === "desktop" ? "desktop accent" : "built-in accent"}${a.glass ? " · Glass" : ""}`}>
        {() => (
          <>
            <Row label="Theme" hint={a.theme === "desktop" ? "Follows your desktop's colors live" : undefined}>
              <Segmented label="Theme" value={a.theme} options={Object.entries(THEME_TEXT) as [Appearance["theme"], string][]} onChange={(theme) => setA({ theme })} />
            </Row>
            {a.theme !== "desktop" && (
              <Row label="Accent color">
                <Segmented
                  label="Accent color"
                  value={a.accent}
                  options={[
                    ["builtin", "CorridorKey"],
                    ["desktop", "Desktop"],
                  ]}
                  onChange={(accent) => setA({ accent })}
                />
              </Row>
            )}
            <Row label="Glass" hint="Liquid Glass on the rail and panels">
              <label className="checks">
                <input type="checkbox" checked={a.glass} onChange={(e) => setA({ glass: e.target.checked })} />
                On
              </label>
            </Row>
          </>
        )}
      </Section>

      <Section id="results" icon={FolderOutput} title="Results" status={state.settings.outputRoot ? `Into ${state.settings.outputRoot}` : "Next to each clip (out_<clip>)"}>
        {() => (
          <Row label="Where results go" hint="For clips added from now on">
            <div className="file-pick">
              <button type="button" className="btn small" onClick={() => window.ck.pickOutputRoot()}>
                <FolderOpen size={14} /> One folder…
              </button>
              {state.settings.outputRoot && (
                <button type="button" className="btn small" onClick={() => window.ck.clearOutputRoot()}>
                  Next to each clip
                </button>
              )}
            </div>
          </Row>
        )}
      </Section>

      <Section id="updates" icon={Download} title="Updates" status={updateStatus(u)}>
        {() => <Updates u={u} queueRunning={state.queueRunning} />}
      </Section>
    </Accordion>
  );

  return (
    <SplitView
      main={main}
      panel={panel}
      panelTitle="App settings"
      panelSub="This PC's settings, saved as you change them"
      shown={props.panelShown}
      narrow={props.narrow}
      glass={props.glass}
      onEscape={props.hidePanel}
    />
  );
}

export function versionText(v: string): string {
  const m = /^(\d+\.\d+\.\d+)-dev\.(\d+)$/.exec(v);
  return m ? `${m[1]} Dev ${m[2]}` : v;
}

function updateStatus(u: UpdateState): string {
  switch (u.status) {
    case "unsupported":
      return "Not available in this copy";
    case "checking":
      return "Checking…";
    case "current":
      return `Up to date · ${versionText(u.current)}`;
    case "available":
      return `${versionText(u.latest ?? "")} is available`;
    case "downloading":
      return `Downloading ${Math.round((u.progress ?? 0) * 100)}%`;
    case "ready":
      return `${versionText(u.latest ?? "")} ready · restart to use it`;
    case "error":
      return u.error ?? "Update check failed";
    default:
      return u.channel === "dev" ? "Development channel" : "Stable channel";
  }
}

function Updates({ u, queueRunning }: { u: UpdateState; queueRunning: boolean }) {
  if (u.status === "unsupported") {
    return (
      <p className="hint-text">
        {u.feed ? "This copy runs from source; updates install into the AppImage." : "There's no release channel for CorridorKey Desktop yet. Updates turn on with the first published release."}
      </p>
    );
  }
  return (
    <>
      <Row label="Channel" hint={u.channel === "dev" ? "New features first; may have rough edges" : undefined}>
        <Segmented
          label="Update channel"
          value={u.channel}
          options={[
            ["stable", "Stable"],
            ["dev", "Development"],
          ]}
          onChange={(c) => void window.ck.setUpdateChannel(c)}
        />
      </Row>
      <Row label="Check automatically">
        <label className="checks">
          <input type="checkbox" checked={u.automatic} onChange={(e) => void window.ck.setAutoUpdate(e.target.checked)} />
          At start and every few hours
        </label>
      </Row>
      <Row label="Now">
        <div className="file-pick">
          <button type="button" className="btn small" disabled={u.status === "checking" || u.status === "downloading"} onClick={() => window.ck.checkForUpdates()}>
            <RefreshCw size={14} /> Check now
          </button>
          {u.status === "available" && (
            <button type="button" className="btn small primary" onClick={() => window.ck.installUpdate()}>
              <Download size={14} /> Download {versionText(u.latest ?? "")}
            </button>
          )}
          {u.status === "ready" && (
            <button type="button" className="btn small primary" disabled={queueRunning} title={queueRunning ? "After the queue finishes" : undefined} onClick={() => window.ck.restartToUpdate()}>
              <RotateCcw size={14} /> Restart now
            </button>
          )}
        </div>
      </Row>
      {u.channel === "stable" && /-dev\.\d+$/.test(u.current) && (
        <Row label="Back to stable" hint="Installs the newest stable release over this dev build">
          <button type="button" className="btn small" disabled={u.status === "checking" || u.status === "downloading"} onClick={() => window.ck.backToStable()}>
            <RotateCcw size={14} /> Back to stable
          </button>
        </Row>
      )}
      {u.notes && <p className="hint-text">{u.notes}</p>}
    </>
  );
}
