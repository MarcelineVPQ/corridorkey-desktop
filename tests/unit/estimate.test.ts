import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ESTIMATE_FRESH_MS, Estimator, estimateErrorText, estimateRequest, parseEstimate } from "../../electron/main/estimate";
import type { EngineReply } from "../../electron/main/engine";
import { untilEnded } from "../../electron/main/gpu";
import type { EngineHandle } from "../../electron/main/queue";
import { MANUAL_WINDOWS, VRAM_LIMIT_AUTO_HELP } from "../../src/shared/types";

const GIB = 1073741824;

// the engine's reply for a request: one estimate per window asked, 1 GiB per window frame (a fake, not the table)
function reply(req: Record<string, unknown>): EngineReply {
  const windows = (req.windows as [number, number, boolean][]).map(([c, s, low]) => ({
    hann_chunk: c,
    hann_stride: s,
    low_vram: low,
    frames: c,
    peak_bytes: c * GIB,
    needs_bytes: c * GIB * 1.1,
    fits: c <= 8,
  }));
  return { type: "estimate", id: String(req.id), width: 1920, height: 1080, shape_w: 1920, shape_h: 1152, frames: 240, total_bytes: 16 * GIB, free_bytes: 13 * GIB, budget_bytes: 13 * GIB, windows };
}

function harness(answer: (req: Record<string, unknown>) => EngineReply | null = reply, busy?: () => boolean) {
  let clock = 1000;
  const engines: { sent: Record<string, unknown>[]; quits: number; kills: number }[] = [];
  const est = new Estimator({
    makeEngine: (onReply) => {
      const e = { sent: [] as Record<string, unknown>[], quits: 0, kills: 0 };
      engines.push(e);
      const h: EngineHandle = {
        running: true,
        start: () => Promise.resolve({ type: "pong", protocol: 1 }),
        send: (m) => {
          e.sent.push(m);
          const r = answer(m);
          if (r) setTimeout(() => onReply(r), 0);
        },
        quit: () => e.quits++,
        kill: () => e.kills++,
        stderrTail: () => [],
      };
      return h;
    },
    busy,
    now: () => clock,
  });
  return { est, engines, tick: (ms: number) => (clock += ms) };
}

describe("the estimate gives way to the Console (senior review 2026-10-26 N9)", () => {
  it("says while the engine stop() killed hasn't exited", async () => {
    const h = { running: true, start: () => Promise.resolve({ type: "pong", protocol: 1 }), send: () => {}, quit: () => {}, kill: () => {}, stderrTail: () => [] };
    let made = false;
    const est = new Estimator({ makeEngine: () => ((made = true), h) });
    void est.ask("/c.mov", false);
    await vi.waitFor(() => expect(made).toBe(true));
    expect(est.engineEnding).toBe(false);
    est.stop();
    expect(est.engineEnding).toBe(true);
    h.running = false;
    expect(est.engineEnding).toBe(false);
  });

  it("untilEnded resolves once the stopped engines are gone, or at its deadline", async () => {
    let ending = true;
    setTimeout(() => (ending = false), 20);
    const t0 = Date.now();
    await untilEnded(() => ending, 5000, 5);
    expect(ending).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
    const t1 = Date.now();
    await untilEnded(() => true, 30, 5);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(25);
  });
});

describe("memory estimate (backlog row 41)", () => {
  it("asks for every manual window in both modes", () => {
    const r = estimateRequest("e1", "/c.mov");
    expect(r.cmd).toBe("estimate");
    expect(r.windows).toHaveLength(MANUAL_WINDOWS.length * 2);
    expect(r.windows).toContainEqual([24, 12, true]);
    expect(r).not.toHaveProperty("model_scale");
    // the internal resolution (backlog row 42): the estimate is the scaled size's
    expect(estimateRequest("e2", "/c.mov", null, 0.5)).toMatchObject({ model_scale: 0.5 });
  });

  it("starts an engine, asks once, quits it, and gives the engine's numbers", async () => {
    const h = harness();
    const r = await h.est.ask("/c.mov", false);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stale).toBe(false);
    expect(r.estimate.freeBytes).toBe(13 * GIB);
    const w = r.estimate.windows.find((x) => x.hannChunk === 24 && x.lowVram);
    expect(w).toMatchObject({ peakBytes: 24 * GIB, fits: false });
    expect(h.engines).toHaveLength(1);
    expect(h.engines[0].sent).toHaveLength(1);
    expect(h.engines[0].quits).toBe(1);
  });

  it("reuses a fresh reading, asks again once it's old", async () => {
    const h = harness();
    await h.est.ask("/c.mov", false);
    await h.est.ask("/c.mov", false);
    expect(h.engines).toHaveLength(1);
    h.tick(ESTIMATE_FRESH_MS + 1);
    await h.est.ask("/c.mov", false);
    expect(h.engines).toHaveLength(2);
  });

  it("weighs the windows against the clip's limit: sent as vram_budget_gb, one reading per limit (backlog row 43)", async () => {
    expect(estimateRequest("e1", "/c.mov")).not.toHaveProperty("vram_budget_gb");
    expect(estimateRequest("e1", "/c.mov", 10)).toMatchObject({ vram_budget_gb: 10 });
    // the engine caps its budget at the request's limit and says so (budget_cap_gb)
    const h = harness((m) => ({ ...reply(m), budget_bytes: typeof m.vram_budget_gb === "number" ? m.vram_budget_gb * GIB : 13 * GIB, budget_cap_gb: m.vram_budget_gb ?? null }));
    const auto = await h.est.ask("/c.mov", false, null);
    const limited = await h.est.ask("/c.mov", false, 6);
    expect(h.engines).toHaveLength(2);
    expect(h.engines[1].sent[0]).toMatchObject({ cmd: "estimate", vram_budget_gb: 6 });
    expect(auto.ok && auto.estimate.capGb).toBeNull();
    expect(limited.ok && [limited.estimate.capGb, limited.estimate.budgetBytes]).toEqual([6, 6 * GIB]);
    // each limit keeps its own fresh reading
    await h.est.ask("/c.mov", false, 6);
    await h.est.ask("/c.mov", false, null);
    expect(h.engines).toHaveLength(2);
  });

  it("starts no engine while the queue runs: the last reading, marked stale, or why not", async () => {
    const h = harness();
    const none = await h.est.ask("/c.mov", true);
    expect(none.ok).toBe(false);
    expect(h.engines).toHaveLength(0);
    await h.est.ask("/c.mov", false);
    const stale = await h.est.ask("/c.mov", true);
    expect(stale.ok && stale.stale).toBe(true);
    expect(h.engines).toHaveLength(1);
  });

  it("is held off while the Console's corridorkey has the card too (index.ts wiring; review 2026-10-26 S3)", () => {
    const index = readFileSync(new URL("../../electron/main/index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/estimator\.ask\(job\.clip\.path, queue\.running \|\| consoleGpu,/);
  });

  it("an ask waiting its turn starts no engine once the queue or the Console has taken the card (review 2026-10-27)", async () => {
    let busy = false;
    // the queue starts while the first estimate runs
    const h = harness(
      (m) => ((busy = true), reply(m)),
      () => busy,
    );
    const first = h.est.ask("/a.mov", false);
    const second = h.est.ask("/b.mov", false);
    expect((await first).ok).toBe(true);
    expect(await second).toEqual({ ok: false, reason: expect.stringMatching(/nothing is keying/) });
    expect(h.engines).toHaveLength(1);
  });

  it("one engine at a time: two clips asked together run one after the other", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.est.ask("/a.mov", false), h.est.ask("/b.mov", false)]);
    expect(a.ok && b.ok).toBe(true);
    expect(h.engines).toHaveLength(2);
    expect(h.engines.every((e) => e.quits === 1)).toBe(true);
  });

  it("an engine error says why; an older engine's unknown command says so", async () => {
    const h = harness((m) => ({ type: "error", id: String(m.id), code: "input", message: "input not found: /x.mov" }));
    const r = await h.est.ask("/x.mov", false);
    expect(r).toEqual({ ok: false, reason: "The engine couldn't estimate this clip: input not found: /x.mov" });
    expect(estimateErrorText({ type: "error", code: "bad-request", message: "unknown cmd: estimate" })).toMatch(/older engine/);
  });

  it("a reply that isn't an estimate isn't shown", () => {
    expect(parseEstimate({ type: "pong" }, 0)).toBeNull();
    expect(parseEstimate({ type: "estimate", windows: [{ hann_chunk: 8, peak_bytes: "x" }] }, 0)).toBeNull();
    const ok = parseEstimate(
      {
        type: "estimate",
        width: 2,
        height: 2,
        frames: 2,
        total_bytes: null,
        free_bytes: null,
        budget_bytes: null,
        windows: [{ hann_chunk: 8, hann_stride: 4, low_vram: false, peak_bytes: 1, needs_bytes: 2, fits: null }],
      },
      5,
    );
    expect(ok?.windows[0].fits).toBeNull();
    expect(ok?.freeBytes).toBeNull();
  });
});

// hard-coded pass 2026-10-26 S8: the automatic window's margin in the app's help and the in-app guide is vram.rs's
describe("the automatic window's safety margin", () => {
  it("says what vram.rs's MARGIN_SCALE and MARGIN_GB are", () => {
    const vram = readFileSync(new URL("../../engine-rs/crates/ck-core/src/vram.rs", import.meta.url), "utf8");
    const scale = /const MARGIN_SCALE: f64 = ([\d.]+);/.exec(vram)?.[1];
    const gb = /const MARGIN_GB: f64 = ([\d.]+);/.exec(vram)?.[1];
    expect(scale && gb).toBeTruthy();
    expect(VRAM_LIMIT_AUTO_HELP).toContain(`× ${scale} + ${gb} GiB`);
    const guide = readFileSync(new URL("../../docs/GUIDE.md", import.meta.url), "utf8");
    // loop: NOT-WORTH — the guide's few margin mentions
    const said = [...guide.matchAll(/× ([\d.]+) \+ ([\d.]+) GiB/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(said.length).toBeGreaterThan(0);
    expect(new Set(said)).toEqual(new Set([`${scale} ${gb}`]));
  });
});
