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
});
