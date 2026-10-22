// The app shell: the page and its panel on the left, the rail on the right
// edge (the house layout of the DS5 app and Sonata). Drop clips anywhere.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppState } from "../shared/types";
import { dots, jobToSelect, tasksOf, type PageId } from "../shared/tasks";
import { AppRail } from "./rail/AppRail";
import { railPress } from "./rail/railModel";
import { NARROW } from "./panel/SplitView";
import { usePref } from "./prefs";
import { useTheme } from "./theme/useTheme";
import { QueuePage } from "./pages/QueuePage";
import { EnginePage } from "./pages/EnginePage";
import { SettingsPage } from "./pages/SettingsPage";
import { AboutPage } from "./pages/AboutPage";

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = usePref<PageId>("ck.page", "queue");
  // Panels start shown (Marcy 2026-10-22: shown is the default); a hide lasts until the page is opened again.
  const [panels, setPanels] = useState<Partial<Record<PageId, boolean>>>({});
  const [focus, setFocus] = useState<{ page: PageId; section: string; n: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [width, setWidth] = useState(window.innerWidth);

  useEffect(() => {
    void window.ck.getState().then(setState);
    const off = window.ck.onState(setState);
    // The GPU readout runs only while the window is shown (main process gates it).
    const vis = () => window.ck.setVisible(document.visibilityState === "visible");
    vis();
    document.addEventListener("visibilitychange", vis);
    const onResize = () => setWidth(window.innerWidth);
    // lifetime: OK — both removed on unmount
    window.addEventListener("resize", onResize);
    return () => {
      off();
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useTheme(state?.settings.appearance ?? { theme: "system", accent: "builtin", glass: false }, state?.desktopPalette ?? null);

  // Select the first clip when nothing (or a removed clip) is selected.
  useEffect(() => {
    if (!state) return;
    // loop: HOT-PATH-OK — the queue's jobs per state push (≤ 10/s while shown)
    if (!selected || !state.jobs.some((j) => j.id === selected)) setSelected(state.jobs[0]?.id ?? null);
  }, [state, selected]);

  const tasks = useMemo(() => (state ? tasksOf(state) : []), [state]);
  const d = useMemo(() => dots(tasks), [tasks]);
  const narrow = width < NARROW;
  // Wide: a panel is shown unless hidden; narrow: it's a drawer, closed unless opened.
  const panelShown = (p: PageId) => panels[p] ?? !narrow;
  const setPanel = useCallback((p: PageId, shown: boolean) => setPanels((old) => ({ ...old, [p]: shown })), [setPanels]);

  const onPress = (pressed: PageId) => {
    const target = d.targets[pressed] ?? null;
    const r = railPress(pressed, page, panelShown(page), target);
    setPage(r.page);
    if (r.panel === "show") setPanel(r.page, true);
    if (r.panel === "hide") setPanel(r.page, false);
    if (r.section) setFocus({ page: r.page, section: r.section, n: Date.now() });
    // a queue task about one clip selects it
    const job = jobToSelect(tasks, pressed);
    if (job) setSelected(job);
  };

  if (!state) return null;
  const glass = state.settings.appearance.glass;
  const common = { narrow, glass, hidePanel: () => setPanel(page, false), focus: focus?.page === page ? focus.section : null };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    // loop: NOT-WORTH — the dropped files, once per drop
    const paths = [...e.dataTransfer.files].map((f) => window.ck.pathForFile(f)).filter(Boolean);
    if (paths.length) {
      void window.ck.addPaths(paths);
      setPage("queue");
    }
  };

  return (
    <div
      className="shell"
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.relatedTarget) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <main className="shell-page">
        {page === "queue" && <QueuePage state={state} selected={selected} onSelect={setSelected} panelShown={panelShown("queue")} sectionTasks={d.sections} {...common} />}
        {page === "engine" && <EnginePage state={state} panelShown={panelShown("engine")} sectionTasks={d.sections} {...common} />}
        {page === "settings" && <SettingsPage state={state} panelShown={panelShown("settings")} {...common} />}
        {page === "about" && <AboutPage version={state.version} panelShown={panelShown("about")} {...common} />}
      </main>
      <AppRail state={state} page={page} pageDots={d.pages} onPress={onPress} glass={glass} windowWidth={width} />
      {dragging && <div className="drop-overlay">Drop to add to the queue</div>}
    </div>
  );
}
