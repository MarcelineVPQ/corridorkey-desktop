// "More": the rest of an explanation, one press away (UI pass 2026-10-25, Marcy: one or two plain lines, then More
// for the rest). A button with aria-expanded over the text it shows; closed, the text isn't in the page.
import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function More({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="more">
      <button type="button" className="link-btn more-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {open ? "Less" : "More"}
        <ChevronDown size={14} aria-hidden className="more-chev" />
      </button>
      <div id={id} className="more-body" hidden={!open}>
        {open && children}
      </div>
    </div>
  );
}
