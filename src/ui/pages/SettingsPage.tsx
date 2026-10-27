// App settings: this PC's choices, saved as you change them (no save bar).
// Main view: what they add up to (readouts). Panel: Appearance, Results,
// Console (the folders it may also write in), Updates, Storage (what the app keeps on disk, each folder removable). Every
// control changes something you can see (rule 4).
import { useEffect } from "react";
import { Download, FolderInput, FolderOpen, FolderOutput, HardDrive, MemoryStick, Palette, RefreshCw, RotateCcw, SquareTerminal, Trash2, X } from "lucide-react";
import type { Appearance, AppState, CacheInfo, UpdateState } from "../../shared/types";
import { gibBytes, mbOrGbBytes } from "../../shared/units";
import { VramLimitRow } from "../JobSettings";
import { NOT_WHILE_BUSY } from "../../shared/texts";
import { Accordion, Row, Section, Segmented } from "../panel/Section";
import { MainBlock, SplitView } from "../panel/SplitView";
import { Stat } from "../JobView";
import { gbBytes } from "../format";
import { More } from "../More";
import { PathText } from "../PathText";
import { shortenPath } from "../paths";

// where results go without an output folder (the readout, the Results status and its button)
const NEXT_TO_CLIP = "Next to each clip";

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
  const allowed = state.settings.consoleWriteFolders;
  // Storage is measured when this page opens (walking the folders), and again after a removal
  useEffect(() => void window.ck.measureStorage(), []);
  const storage = state.storage;
  const busy = state.queueRunning || state.install.status === "running" || state.tensorrt.status === "running";
  // loop: NOT-WORTH — four items per render
  const storageTotal = storage ? storage.reduce((n, i) => n + i.bytes, 0) : null;
  // the limit new clips start with (row 43): the menu runs up to the card's size as the engine last read it, else the driver's (the queue's pong)
  const limit = state.settings.vramLimitGb;
  const pongTotal = state.engine.pong?.vramTotalMb;
  const cardTotal = state.card?.totalBytes ?? (pongTotal ? pongTotal * 1048576 : null);
  const c = state.card;
  const cardLine = c
    ? `This card: ${c.totalBytes !== null ? gibBytes(c.totalBytes) : "size unknown"}${c.freeBytes !== null ? `, ${gibBytes(c.freeBytes)} free at ${new Date(c.at).toLocaleTimeString()}` : ""}`
    : pongTotal
      ? `This card: ${gibBytes(pongTotal * 1048576)}`
      : "Card size: read with a clip's memory estimate";

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
            <Stat k="Results go" v={state.settings.outputRoot ? "Into one folder" : NEXT_TO_CLIP} />
            <Stat k="Version" v={versionText(state.version)} />
          </div>
          {desktopNote && <p className="hint-text">{desktopNote}</p>}
          {state.settings.outputRoot && <PathText path={state.settings.outputRoot} />}
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

      <Section
        id="results"
        icon={FolderOutput}
        title="Results"
        status={state.settings.outputRoot ? `Into ${shortenPath(state.settings.outputRoot, state.system.home, 40)}` : `${NEXT_TO_CLIP} (out_<clip>)`}
      >
        {() => (
          <Row label="Where results go" hint="For clips added from now on">
            <div className="file-pick">
              <button type="button" className="btn small" onClick={() => window.ck.pickOutputRoot()}>
                <FolderOpen size={14} /> One folder…
              </button>
              {state.settings.outputRoot && (
                <button type="button" className="btn small" onClick={() => window.ck.clearOutputRoot()}>
                  {NEXT_TO_CLIP}
                </button>
              )}
            </div>
          </Row>
        )}
      </Section>

      <Section
        id="console"
        icon={SquareTerminal}
        title="Console"
        status={allowed.length ? `writes in ${allowed.length} more folder${allowed.length === 1 ? "" : "s"}` : "writes only in the results and cache folders"}
      >
        {() => (
          <>
            {/* loop: NOT-WORTH — ≤ 100 folders per render */}
            {allowed.map((f) => (
              <Row key={f} label="May write in" hint={<PathText path={f} />}>
                <button type="button" className="btn small" onClick={() => void window.ck.consoleDisallow(f)}>
                  <X size={14} /> Remove
                </button>
              </Row>
            ))}
            <p className="hint-text">
              {allowed.length ? "Removing takes effect at once; the files there stay." : "None yet."} The Console&apos;s <code>allow &lt;folder&gt;</code> adds one, after you confirm it.
            </p>
          </>
        )}
      </Section>

      {state.system.platform !== "darwin" && (
        <Section id="memory" icon={MemoryStick} title="Graphics memory" status={limit === null ? "New clips: Auto limit" : `New clips: limit ${limit} GiB`}>
          {() => (
            <>
              <VramLimitRow id="vlimit-default" value={limit} totalBytes={cardTotal} cardText={cardLine} provider={null} onChange={(gb) => void window.ck.setVramLimitDefault(gb)} />
              <p className="hint-text">For clips added from now on; each clip can change it in its Graphics memory section.</p>
            </>
          )}
        </Section>
      )}

      <Section id="updates" icon={Download} title="Updates" status={updateStatus(u)}>
        {() => <Updates u={u} queueRunning={state.queueRunning} />}
      </Section>
      <Section id="storage" icon={HardDrive} title="Storage" status={storageTotal === null ? "measuring…" : `${gbBytes(storageTotal)} on this PC`}>
        {() =>
          !storage ? (
            <p className="hint-text">Measuring…</p>
          ) : (
            <>
              {/* loop: NOT-WORTH — three folders per render */}
              {storage.map((i) => (
                <Row key={i.id} label={`${i.label} · ${i.bytes ? gbBytes(i.bytes) : "empty"}`} hint={<PathText path={i.path} />}>
                  <div className="file-pick">
                    <button type="button" className="btn small" disabled={!i.bytes} onClick={() => void window.ck.openStorageFolder(i.id)}>
                      <FolderOpen size={14} /> Open
                    </button>
                    <button type="button" className="btn small" disabled={!i.bytes || busy} title={busy ? NOT_WHILE_BUSY : undefined} onClick={() => void window.ck.removeStorage(i.id)}>
                      <Trash2 size={14} /> Remove…
                    </button>
                  </div>
                </Row>
              ))}
              {state.cache && <CacheFolder cache={state.cache} missing={state.cacheMissing} busy={busy} />}
              <p className="hint-text">Removing asks first. Your settings and results are never touched here.</p>
              <More>
                <p className="hint-text">
                  The cache folder holds, per clip, its thumbnail and result stills; a job&apos;s working files stay in the system&apos;s cache folder on this PC wherever the cache folder is. Changing
                  the cache folder asks whether to move the files or start fresh. The runtime and models come back through the setup when you need them
                  {state.tensorrt.supported ? ", TensorRT through its switch (Engine settings)" : ""}.
                </p>
              </More>
            </>
          )
        }
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
    return <p className="hint-text">{u.error ?? "Updates aren't available in this copy."}</p>;
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

/**
 * The cache folder (backlog row 44): where it is (Change…, back to the system's folder, Open), what it holds per
 * clip in the queue and per TensorRT range, measured with Storage.
 */
function CacheFolder({ cache, missing, busy }: { cache: CacheInfo; missing: string | null; busy: boolean }) {
  const locked = busy || cache.moving !== null;
  return (
    <>
      {missing && (
        <>
          <p className="estimate no-fit" role="alert">
            <strong>Drive not available.</strong> {missing} The cache is in the default folder for now; nothing was moved or deleted.
          </p>
          <More>
            <p className="hint-text">The chosen folder is used again when the app starts with its drive connected.</p>
          </More>
          <div className="file-pick">
            <button type="button" className="btn small" disabled={locked} title={busy ? NOT_WHILE_BUSY : cache.defaultDir} onClick={() => void window.ck.pickCacheFolder("default")}>
              <RotateCcw size={14} /> Use the default folder from now on
            </button>
          </div>
        </>
      )}
      <Row label={`Cache folder · ${cache.bytes ? mbOrGbBytes(cache.bytes) : "empty"}`} hint={<PathText path={cache.dir} />}>
        <div className="file-pick">
          <button type="button" className="btn small" disabled={locked} title={busy ? NOT_WHILE_BUSY : undefined} onClick={() => void window.ck.pickCacheFolder()}>
            <FolderInput size={14} /> Change…
          </button>
          {!cache.isDefault && (
            <button type="button" className="btn small" disabled={locked} title={busy ? NOT_WHILE_BUSY : cache.defaultDir} onClick={() => void window.ck.pickCacheFolder("default")}>
              <RotateCcw size={14} /> Default
            </button>
          )}
          <button type="button" className="btn small" disabled={!cache.bytes} onClick={() => void window.ck.openStorageFolder("cache-root")}>
            <FolderOpen size={14} /> Open
          </button>
        </div>
      </Row>
      {cache.moving && (
        <p className="hint-text" role="status">
          {cache.moving}
        </p>
      )}
      {cache.error && (
        <p className="estimate no-fit" role="alert">
          {cache.error}
        </p>
      )}
      {(cache.shots.length > 0 || cache.otherBytes > 0 || cache.trtRanges.length > 0) && (
        <ul className="sizes" aria-label="What the cache folder holds">
          {/* loop: HOT-PATH-OK — the queue's clips, per render of Storage (only while it is open) */}
          {cache.shots.map((s, i) => (
            <li key={`${i}-${s.name}`}>
              <span title={s.name}>{s.name}</span>
              <span>{s.bytes ? mbOrGbBytes(s.bytes) : "empty"}</span>
            </li>
          ))}
          {cache.otherBytes > 0 && (
            <li>
              <span>Clips no longer in the queue</span>
              <span>{mbOrGbBytes(cache.otherBytes)}</span>
            </li>
          )}
          {/* loop: HOT-PATH-OK — a few TensorRT ranges, as above */}
          {cache.trtRanges.map((r) => (
            <li key={r.range}>
              <span title={r.range}>TensorRT engines, range {r.range}</span>
              <span>{mbOrGbBytes(r.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
