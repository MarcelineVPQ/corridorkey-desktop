// The job page shows measured numbers only (rule 1): speed and frames come from the engine's replies. Its "Time left"
// was the app's own extrapolation from the rate, so it went (hard-coded pass 2026-10-26 S6, Marcy's decision).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as format from "../../src/ui/format";

describe("job page", () => {
  it("shows no time left extrapolated by the app", () => {
    const view = readFileSync(new URL("../../src/ui/JobView.tsx", import.meta.url), "utf8");
    expect(view).not.toMatch(/Time left/);
    expect(view).toMatch(/Speed \(measured\)/);
    expect(view).toMatch(/Frames written/);
    expect(Object.keys(format)).not.toContain("remaining");
  });

  it("whole review S8: a queue row is no role=button around the Remove button; the clip's name is the button", () => {
    const page = readFileSync(new URL("../../src/ui/pages/QueuePage.tsx", import.meta.url), "utf8");
    const row = page.slice(page.indexOf("function JobRowView"), page.indexOf("function Detail"));
    expect(row).not.toMatch(/role="button"/);
    expect(row).toMatch(/<button type="button" className="job-name"/);
  });

  it("re-review N2: an unknown total's bar is a moving band, still under reduced motion (tokens only: the theme gate)", () => {
    const css = readFileSync(new URL("../../src/styles/app.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.bar\.indeterminate > span \{[^}]*animation: bar-sweep/);
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.bar\.indeterminate > span \{[^}]*animation: none/);
  });
});
