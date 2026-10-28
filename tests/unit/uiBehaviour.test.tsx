// @vitest-environment jsdom
// The renderer's components rendered and driven as a user would (senior review S6: the source-text checks and the pure
// models missed M1, M2 and S3). Each regression the review found has a test here that fails without its fix.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleBlock, ConsoleCompletion, JobOptions } from "../../src/shared/types";
import { makeRegistry } from "../../src/shared/console/registry";
import { LineEditor, type LineEditorHandle } from "../../src/ui/console/LineEditor";
import { OutputBlock } from "../../src/ui/console/OutputBlock";
import { JobSettings } from "../../src/ui/JobSettings";
import { JobView } from "../../src/ui/JobView";
import { PathText } from "../../src/ui/PathText";
import { ProgressBar } from "../../src/ui/ProgressBar";
import { Accordion, Section } from "../../src/ui/panel/Section";
import { EnginePage } from "../../src/ui/pages/EnginePage";
import { SettingsPage } from "../../src/ui/pages/SettingsPage";
import { ConsolePage } from "../../src/ui/pages/ConsolePage";
import { STAGE_TEXT } from "../../src/ui/format";
import { appState, job, settings } from "./fixtures";
import { Cpu } from "lucide-react";

const registry = makeRegistry();

/** window.ck: every call answers never (a page's background asks), unless a test gives it an answer. */
function mockCk(answers: Record<string, (...a: never[]) => unknown> = {}) {
  // loop: NOT-WORTH — a property lookup per call in a test
  const ck = new Proxy({} as Record<string, unknown>, { get: (t, k: string) => (t[k] ??= answers[k] ? vi.fn(answers[k]) : vi.fn(() => new Promise(() => {}))) });
  (window as unknown as { ck: unknown }).ck = ck;
  return ck as Record<string, ReturnType<typeof vi.fn>>;
}

beforeEach(() => {
  localStorage.clear();
  // jsdom has none of these
  Element.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("LineEditor (the Console's input)", () => {
  const props = {
    registry,
    windows: false,
    history: [],
    past: [],
    running: false,
    elevated: false,
    folder: "~",
    mode: "inline" as const,
    autosuggest: false,
    onMode: () => {},
    onRun: () => {},
    onRunLines: () => {},
    onCancel: () => {},
    onClear: () => {},
    onJump: () => {},
  };

  it("review M1: Tab and Shift+Tab on an empty line aren't taken (focus moves on; no keyboard trap)", () => {
    const ck = mockCk();
    render(<LineEditor {...props} />);
    const input = screen.getByRole("combobox", { name: "Command" });
    input.focus();
    // fireEvent returns false when the handler called preventDefault (the browser would not move focus)
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Tab", shiftKey: true })).toBe(true);
    expect(ck.consoleComplete).not.toHaveBeenCalled();
  });

  it("Tab on a typed word waits for the main process's completion, once for two quick Tabs, and inserts it", async () => {
    let answer: (c: ConsoleCompletion) => void = () => {};
    const ck = mockCk({ consoleComplete: () => new Promise<ConsoleCompletion>((r) => (answer = r)) });
    const ref = createRef<LineEditorHandle>();
    render(<LineEditor {...props} ref={ref} />);
    const input = screen.getByRole<HTMLInputElement>("combobox", { name: "Command" });
    act(() => ref.current!.insert("ver"));
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
    expect(ck.consoleComplete).toHaveBeenCalledTimes(1);
    await act(async () => answer({ start: 0, end: 3, items: [{ insert: "verify", label: "verify", kind: "command", help: "" }] }));
    await waitFor(() => expect(input.value).toBe("verify "));
  });
});

describe("JobSettings (a clip's settings)", () => {
  const show = (onChange: (o: JobOptions) => Promise<void>, j = job("a")) => {
    // the Outputs section open (the accordion remembers it per page)
    localStorage.setItem("ck.open.queue", JSON.stringify("outputs"));
    return render(<JobSettings job={j} focus={null} sectionTasks={{}} queueRunning={false} platform="linux" onChange={onChange} />);
  };

  it("review M2: a change shows at once, and a second quick change keeps the first (no push echoed yet)", () => {
    mockCk();
    // the main process never answers in this test: the controls may not wait for it
    const onChange = vi.fn((_o: JobOptions) => new Promise<void>(() => {}));
    show(onChange);
    const checker = screen.getByRole<HTMLInputElement>("checkbox", { name: "Checker" });
    const cutout = screen.getByRole<HTMLInputElement>("checkbox", { name: "Cutout" });
    fireEvent.click(checker);
    expect(checker.checked).toBe(true);
    fireEvent.click(cutout);
    expect(cutout.checked).toBe(true);
    expect(checker.checked).toBe(true);
    expect(onChange.mock.calls.at(-1)![0].outputs).toEqual(["alpha", "fg", "checker", "cutout"]);
    // a slider moved twice stays where it was moved
    const despill = screen.getByRole<HTMLInputElement>("slider", { name: "Despill" });
    fireEvent.change(despill, { target: { value: "0.6" } });
    fireEvent.change(despill, { target: { value: "0.7" } });
    expect(despill.value).toBe("0.7");
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ despillStrength: 0.7, outputs: ["alpha", "fg", "checker", "cutout"] });
  });

  it("the first push after every change was applied is the truth again (the main process may have changed it)", async () => {
    mockCk();
    const onChange = vi.fn(async (_o: JobOptions) => {});
    const j = job("a");
    const { rerender } = show(onChange, j);
    fireEvent.click(screen.getByRole("checkbox", { name: "Checker" }));
    await act(async () => {});
    // the push: the main process kept only Alpha
    rerender(<JobSettings job={{ ...j, options: { ...j.options, outputs: ["alpha"] } }} focus={null} sectionTasks={{}} queueRunning={false} platform="linux" onChange={onChange} />);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Checker" }).checked).toBe(false);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Foreground" }).checked).toBe(false);
  });
});

describe("OutputBlock (a Console block)", () => {
  const block = (id: number, extra: Partial<ConsoleBlock> = {}): ConsoleBlock => ({
    id,
    line: "info",
    parent: null,
    cwd: "/home/m",
    argv: null,
    elevated: false,
    state: "done",
    exitCode: 0,
    exitMeaning: "done",
    startedAt: 1000,
    finishedAt: 1400,
    progress: null,
    status: null,
    lines: [{ kind: "out", text: "ok" }],
    linesDropped: 0,
    entries: null,
    errors: [],
    clear: false,
    ...extra,
  });

  it("review S3: opening and collapsing a program's command row keeps focus on its toggle", () => {
    mockCk();
    render(<OutputBlock b={block(2, { parent: 1, line: "ls sh010" })} registry={registry} windows={false} selected={false} onReinsert={() => {}} />);
    const row = screen.getByTitle("Show the whole block");
    row.focus();
    fireEvent.click(row);
    expect(document.activeElement?.getAttribute("title")).toBe("Fold this command into one row");
    fireEvent.click(document.activeElement!);
    expect(document.activeElement?.getAttribute("title")).toBe("Show the whole block");
  });

  it("review N3: Copy output joins the text on the press", async () => {
    const ck = mockCk({ copyText: async () => true });
    render(
      <OutputBlock
        b={block(1, {
          lines: [
            { kind: "out", text: "a" },
            { kind: "out", text: "b" },
          ],
        })}
        registry={registry}
        windows={false}
        selected={false}
        onReinsert={() => {}}
      />,
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy output" })));
    expect(ck.copyText).toHaveBeenCalledWith("a\nb");
  });
});

describe("Section (the house accordion)", () => {
  const three = () =>
    render(
      <Accordion page="t" focus={null}>
        {/* loop: NOT-WORTH — three sections in a test */}
        {["one", "two", "three"].map((id) => (
          <Section key={id} id={id} icon={Cpu} title={id} status={`${id} status`}>
            {() => <p>{id} body</p>}
          </Section>
        ))}
      </Accordion>,
    );
  const head = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

  it("one section open at a time; its body exists only while open; a pinned one stays open", () => {
    three();
    expect(screen.queryByText("one body")).toBeNull();
    fireEvent.click(head("one"));
    expect(head("one").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("one body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep one open" }));
    fireEvent.click(head("two"));
    expect(screen.getByText("one body")).toBeTruthy();
    expect(screen.getByText("two body")).toBeTruthy();
    fireEvent.click(head("three"));
    expect(screen.queryByText("two body")).toBeNull();
  });

  it("↑ ↓ Home End move between the headers", () => {
    three();
    head("one").focus();
    fireEvent.keyDown(head("one"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(head("two"));
    fireEvent.keyDown(head("two"), { key: "End" });
    expect(document.activeElement).toBe(head("three"));
    fireEvent.keyDown(head("three"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(head("one"));
    fireEvent.keyDown(head("one"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(head("three"));
    fireEvent.keyDown(head("three"), { key: "Home" });
    expect(document.activeElement).toBe(head("one"));
  });
});

describe("readouts", () => {
  it("review S1 + N4: the stage detail is labelled with its stage; an unknown total is an indeterminate bar", () => {
    mockCk();
    render(<JobView job={job("a", { status: "running", stage: "optimize", stageDetail: "stage 2 refiner (3/5)", framesTotal: null, startedAt: Date.now() })} />);
    expect(screen.queryByText("Stage 1")).toBeNull();
    // the stage row and the stat both name it
    expect(screen.getAllByText(STAGE_TEXT.optimize)).toHaveLength(2);
    const bar = screen.getByRole("progressbar", { name: "Frames written" });
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.hasAttribute("aria-valuemax")).toBe(false);
  });

  it("review N4: a known total keeps its value and range", () => {
    render(<ProgressBar label="Frames" value={3} max={10} />);
    const bar = screen.getByRole("progressbar", { name: "Frames" });
    expect([bar.getAttribute("aria-valuenow"), bar.getAttribute("aria-valuemax")]).toEqual(["3", "10"]);
  });

  it("review N7: each path's Copy names its path", () => {
    mockCk();
    render(<PathText path="/renders/sh010" />);
    expect(screen.getByRole("button", { name: "Copy /renders/sh010" })).toBeTruthy();
  });

  it("review S4: App settings' Accent readout says the accent on screen (the Desktop theme takes the desktop's)", () => {
    mockCk();
    const state = appState({
      settings: settings({ appearance: { theme: "desktop", accent: "builtin", glass: false } }),
      desktopPalette: { source: "accent", isDark: true, accent: [61, 174, 233] },
    });
    render(<SettingsPage state={state} panelShown={true} narrow={false} glass={false} focus={null} hidePanel={() => {}} />);
    expect(screen.getByText("Desktop accent")).toBeTruthy();
    expect(screen.queryByText("CorridorKey green")).toBeNull();
  });

  it("review S5 + N5: Browse… is a button, not an option the arrow keys reach; unknown runtime parts left out", () => {
    const ck = mockCk();
    const state = appState({
      engine: {
        status: "ready",
        error: null,
        pong: { engine: "ck-engine", version: "1.0.0", protocol: 5, ort: null, provider: "cuda", precision: null, gpu: null, vramTotalMb: null, assets: { stage1: true } },
      } as unknown as ReturnType<typeof appState>["engine"],
    });
    localStorage.setItem("ck.open.engine", JSON.stringify("onnx"));
    render(<EnginePage state={state} panelShown={true} narrow={false} glass={false} focus={null} sectionTasks={{}} hidePanel={() => {}} openSetup={() => {}} />);
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Engine program" });
    // loop: NOT-WORTH — the select's few options
    expect([...select.options].map((o) => o.textContent)).not.toContain("Browse…");
    fireEvent.click(screen.getByRole("button", { name: "Browse for the engine program" }));
    expect(ck.pickRustEngine).toHaveBeenCalledWith("binary");
    expect(screen.getByText("ONNX Runtime (version not reported) · cuda")).toBeTruthy();
    expect(screen.queryByText(/\?/)).toBeNull();
    expect(screen.getByText(/stage1 found by the engine$/)).toBeTruthy();
  });
});

describe("re-review", () => {
  const cblock = (id: number, extra: Partial<ConsoleBlock> = {}): ConsoleBlock => ({
    id,
    line: `render s${id}.mov`,
    parent: null,
    cwd: "/home/m",
    argv: null,
    elevated: false,
    state: "done",
    exitCode: 0,
    exitMeaning: "done",
    startedAt: 1000,
    finishedAt: 1400,
    progress: null,
    status: null,
    lines: [],
    linesDropped: 0,
    entries: null,
    errors: [],
    clear: false,
    ...extra,
  });

  it("N1: opening the Console, or a filter bringing blocks back, announces nothing; a new command still is", () => {
    mockCk();
    localStorage.setItem("ck.open.console", JSON.stringify("session"));
    const page = (blocks: ConsoleBlock[]) => (
      <ConsolePage state={appState()} blocks={{ blocks, clearedTo: 0 }} setBlocks={() => {}} panelShown={true} narrow={false} glass={false} focus={null} hidePanel={() => {}} />
    );
    const old = [cblock(1, { state: "failed", exitCode: 6 }), cblock(2)];
    const { container, rerender } = render(page(old));
    const said = () => container.querySelector('.sr-only[role="status"]')!.textContent;
    expect(said()).toBe("");
    fireEvent.click(screen.getByRole("radio", { name: "Failed only" }));
    expect(said()).toBe("");
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(said()).toBe("");
    rerender(page([...old, cblock(3, { state: "running", exitCode: null })]));
    expect(said()).toBe("render s3.mov: running");
  });

  it("N2: an unknown total is a moving band, not an empty bar", () => {
    const { container } = render(<ProgressBar label="Frames" value={37} max={0} />);
    const bar = container.querySelector(".bar")!;
    expect(bar.classList.contains("indeterminate")).toBe(true);
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("");
    cleanup();
    const known = render(<ProgressBar label="Frames" value={3} max={10} />).container.querySelector(".bar")!;
    expect(known.classList.contains("indeterminate")).toBe(false);
    expect((known.firstElementChild as HTMLElement).style.width).toBe("30%");
    // its style (a moving band; still under reduced motion): jobView.test.ts
  });
});
