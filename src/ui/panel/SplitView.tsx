// A page: its main view (readouts, MainBlocks) and its settings panel beside
// it. The panel is shown or hidden only by the rail item of
// the page you're on (no show button on the page, no hide button in the panel);
// opening a page shows it. Narrow windows: the panel opens as a drawer over the
// page, the page behind is dimmed, and the same rail item, Escape or a click on the dimmed page closes it. The drawer
// is modal: focus moves into it when it opens, and the page behind is inert (no focus, no keys) until it closes; then
// focus returns to the page's main view.
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { mainTakesFocus } from "./drawerFocus";
import { useGlass } from "../glass/useGlass";
import { REGULAR_GLASS } from "../glass/variants";

export const NARROW = 1100;

export function SplitView(props: { main: ReactNode; panel: ReactNode; panelTitle: string; panelSub?: string; shown: boolean; narrow: boolean; glass: boolean; onEscape: () => void }) {
  const { main, panel, panelTitle, panelSub, shown, narrow, glass, onEscape } = props;
  const glassRef = useGlass(glass && narrow && shown, REGULAR_GLASS);
  const mainRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const asideRef = useCallback(
    (el: HTMLElement | null) => {
      panelRef.current = el;
      glassRef(el);
    },
    [glassRef],
  );
  const drawer = narrow && shown;
  const wasDrawer = useRef<boolean | null>(null);
  useEffect(() => {
    if (mainRef.current) mainRef.current.inert = drawer;
    if (drawer) panelRef.current?.focus();
    // runs before the page's own effects: the Console's input line still takes focus after this
    else if (mainTakesFocus(wasDrawer.current, drawer)) mainRef.current?.focus();
    wasDrawer.current = drawer;
  }, [drawer]);
  useEffect(() => {
    if (!narrow || !shown) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onEscape();
    // lifetime: OK — only while the drawer is open; removed when it closes
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow, shown, onEscape]);
  return (
    <div className={`split ${narrow ? "narrow" : ""}`}>
      <div ref={mainRef} tabIndex={-1} className="split-main">
        {main}
      </div>
      {/* the page behind the drawer is dimmed; a click on it closes the drawer, as Escape does */}
      {narrow && shown && <div className="split-scrim" aria-hidden onClick={onEscape} />}
      {shown && (
        <aside
          ref={asideRef}
          tabIndex={-1}
          className={`split-panel ${narrow ? "drawer" : ""} ${glass ? "glass" : ""}`}
          aria-label={panelTitle}
          // the drawer is modal (the page behind is inert): said to screen readers too
          role={drawer ? "dialog" : undefined}
          aria-modal={drawer || undefined}
        >
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
