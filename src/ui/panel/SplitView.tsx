// A page: its main view (readouts, MainBlocks) and its settings panel beside
// it (the DS5 SplitView). The panel is shown or hidden only by the rail item of
// the page you're on (no show button on the page, no hide button in the panel);
// opening a page shows it. Narrow windows: the panel opens as a drawer over the
// page, the page behind is dimmed, and the same rail item, Escape or a click on the dimmed page closes it.
import { useEffect, type ReactNode } from "react";
import { useGlass } from "../glass/useGlass";
import { REGULAR_GLASS } from "../glass/variants";

export const NARROW = 1100;

export function SplitView(props: { main: ReactNode; panel: ReactNode; panelTitle: string; panelSub?: string; shown: boolean; narrow: boolean; glass: boolean; onEscape: () => void }) {
  const { main, panel, panelTitle, panelSub, shown, narrow, glass, onEscape } = props;
  const glassRef = useGlass(glass && narrow && shown, REGULAR_GLASS);
  useEffect(() => {
    if (!narrow || !shown) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onEscape();
    // lifetime: OK — only while the drawer is open; removed when it closes
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow, shown, onEscape]);
  return (
    <div className={`split ${narrow ? "narrow" : ""}`}>
      <div className="split-main">{main}</div>
      {/* the page behind the drawer is dimmed; a click on it closes the drawer, as Escape does */}
      {narrow && shown && <div className="split-scrim" aria-hidden onClick={onEscape} />}
      {shown && (
        <aside ref={glassRef} className={`split-panel ${narrow ? "drawer" : ""} ${glass ? "glass" : ""}`} aria-label={panelTitle}>
          <header className="panel-head">
            <h2>{panelTitle}</h2>
            {panelSub && <div className="panel-sub">{panelSub}</div>}
          </header>
          <div className="panel-body">{panel}</div>
        </aside>
      )}
    </div>
  );
}

/** A readout block in a page's main view: always shown, never folded. */
export function MainBlock({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="block">
      <header className="block-head">
        <h3>{title}</h3>
        {actions}
      </header>
      {children}
    </section>
  );
}
