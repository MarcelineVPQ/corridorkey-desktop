// The one settings framework (the DS5 app's accordion/Section.tsx): every
// page's settings and actions are Sections in its panel. A Section is a
// disclosure: its header (a button, aria-expanded) shows an icon, the title,
// a live status line (how it's set now; the full text as its tooltip) and,
// for a waiting task, a dot on the icon with the task as the status. The pin
// beside the chevron ("Keep open") keeps it open while others fold. One section is
// open at a time (plus the pinned ones), remembered per page. The body is a
// function, rendered only while open: a closed section costs nothing.
// Readouts don't go here: they are MainBlocks in the page's main view.
// Keyboard: Enter/Space opens or folds; ↑ ↓ Home End move between headers.
import { createContext, useContext, useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, Pin, type LucideIcon } from "lucide-react";
import { usePref } from "../prefs";

interface AccordionState {
  open: string | null;
  pinned: string[];
  setOpen: (id: string | null) => void;
  togglePin: (id: string) => void;
  focus: string | null;
}
const AccordionContext = createContext<AccordionState | null>(null);

/** One accordion per page; `focus` opens and scrolls to a section (a task's deep link). */
export function Accordion({ page, focus, children }: { page: string; focus: string | null; children: ReactNode }) {
  const [open, setOpen] = usePref<string | null>(`ck.open.${page}`, null);
  const [pinned, setPinned] = usePref<string[]>(`ck.pinned.${page}`, []);
  useEffect(() => {
    if (focus) setOpen(focus);
  }, [focus, setOpen]);
  // loop: NOT-WORTH — a few pinned sections per click
  const togglePin = (id: string) => setPinned((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.target instanceof HTMLElement) || !e.target.classList.contains("sec-toggle")) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const heads = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button.sec-toggle")];
    const at = heads.indexOf(e.target as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? heads.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + heads.length) % heads.length;
    e.preventDefault();
    heads[next]?.focus();
  };
  return (
    <AccordionContext.Provider value={{ open, pinned, setOpen, togglePin, focus }}>
      <div className="accordion" onKeyDown={onKeys}>
        {children}
      </div>
    </AccordionContext.Provider>
  );
}

export function Section(props: { id: string; icon: LucideIcon; title: string; status: string; task?: string | null; disabled?: string | null; children: () => ReactNode }) {
  const acc = useContext(AccordionContext);
  if (!acc) throw new Error("Section outside an Accordion");
  const { id, icon: Icon, title, status, task, disabled } = props;
  const isPinned = acc.pinned.includes(id);
  const isOpen = isPinned || acc.open === id;
  const bodyId = useId();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (acc.focus === id) ref.current?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [acc.focus, id]);
  // a locked section's reason (a clip that ran: "As used for this run") is said once, in the panel's subtitle
  const line = task ?? status;
  return (
    <section ref={ref} className={`sec ${isOpen ? "open" : ""}`} data-section={id}>
      <div className="sec-head">
        <button type="button" className="sec-toggle" aria-expanded={isOpen} aria-controls={bodyId} onClick={() => acc.setOpen(isOpen && !isPinned ? null : id)}>
          <span className="sec-ic">
            <Icon size={17} aria-hidden />
            {task && <i className="task" aria-hidden />}
          </span>
          <span className="sec-text">
            <span className="sec-title">{title}</span>
            <span className={`sec-status ${task ? "waiting" : ""}`} title={line}>
              {task ? `Waiting: ${task}` : line}
            </span>
          </span>
          <ChevronDown size={16} className="sec-chev" aria-hidden />
        </button>
        <button
          type="button"
          className={`sec-pin ${isPinned ? "on" : ""}`}
          aria-pressed={isPinned}
          aria-label={isPinned ? `Unpin ${title}` : `Keep ${title} open`}
          title={isPinned ? "Kept open: click to let it fold with the others" : "Keep this section open while others fold"}
          onClick={() => acc.togglePin(id)}
        >
          <Pin size={15} aria-hidden fill={isPinned ? "currentColor" : "none"} />
        </button>
      </div>
      {isOpen && (
        <div id={bodyId} className="sec-body">
          <fieldset disabled={Boolean(disabled)}>{props.children()}</fieldset>
        </div>
      )}
    </section>
  );
}

/** A setting's row: its name, an optional short hint (≤ 60 characters, or a path), the control. */
export function Row({ label, hint, htmlFor, children }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="row">
      <div className="row-label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {hint && <span className="row-hint">{hint}</span>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  );
}

/** The one segmented control (radio group). */
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {/* loop: HOT-PATH-OK — a few options per render */}
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}
