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
import { JobSettings, trtPlanFor } from "../../src/ui/JobSettings";
import { JobView } from "../../src/ui/JobView";
import { PathText } from "../../src/ui/PathText";
import { ProgressBar } from "../../src/ui/ProgressBar";
import { Accordion, Section } from "../../src/ui/panel/Section";
import { EnginePage } from "../../src/ui/pages/EnginePage";
import { SetupPage } from "../../src/ui/pages/SetupPage";
import { SettingsPage } from "../../src/ui/pages/SettingsPage";
import { ConsolePage } from "../../src/ui/pages/ConsolePage";
import { MIGRAPHX_LOAD, STAGE_TEXT } from "../../src/ui/format";
import { appState, clipInfo, installState, job, settings, trtState, updateState } from "./fixtures";
import { TrtBox } from "../../src/ui/setup/SetupParts";
import { App } from "../../src/ui/App";
import { dots, tasksOf } from "../../src/shared/tasks";
import { UpdateBanner } from "../../src/ui/UpdateBanner";
import { AMD_UNTESTED, TRT_MODEL_SET_NOTE, UPDATE_PAGE_BACK_TO_STABLE } from "../../src/shared/texts";
import type { AppState, UpdateState } from "../../src/shared/types";
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

  // backlog row 166: on an AMD card (MIGraphX) the load compiles each network the first time at each size
  it("says the load prepares for the card when MIGraphX runs the job, and is the plain load otherwise", () => {
    mockCk();
    const tech = { provider: "migraphx", precision: "fp16", tensorrtRequested: false, fallbackReason: null, fallbacks: {}, range: null, cache: null, notAsked: null, modelSet: null, modelsDir: null };
    const { unmount } = render(<JobView job={job("a", { status: "running", stage: "load", stageDetail: "C-RADIO", tech, startedAt: Date.now() })} />);
    expect(screen.getAllByText(MIGRAPHX_LOAD)).toHaveLength(2);
    expect(screen.queryByText(STAGE_TEXT.load)).toBeNull();
    unmount();
    render(<JobView job={job("b", { status: "running", stage: "load", stageDetail: "C-RADIO", tech: { ...tech, provider: "cuda" }, startedAt: Date.now() })} />);
    expect(screen.getAllByText(STAGE_TEXT.load)).toHaveLength(2);
  });

  it("the Model set tile says the version; its long folder is its own shortened line, never clipped in the tile", () => {
    mockCk();
    const dir = "/home/someone/.local/share/corridorkey-desktop/models/2.0.0-onnx.5";
    const tech = {
      provider: "cuda",
      precision: "fp16",
      tensorrtRequested: false,
      fallbackReason: null,
      fallbacks: {},
      range: null,
      cache: null,
      notAsked: null,
      modelSet: "2.0.0-onnx.5",
      modelsDir: dir,
    };
    const { container } = render(<JobView job={job("a", { status: "done", tech })} />);
    const tile = [...container.querySelectorAll(".stat")].find((el) => el.textContent?.startsWith("Model set"));
    expect(tile?.textContent).toBe("Model set2.0.0-onnx.5");
    expect(screen.getByText(/Model set folder:/)).toBeTruthy();
    expect(screen.getByTitle(dir)).toBeTruthy();
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
    render(<SettingsPage state={state} panelShown={true} narrow={false} glass={false} focus={null} sectionTasks={{}} hidePanel={() => {}} />);
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

// BACKLOG row 168: Engine settings, ONNX Runtime engine, "Model set"
describe("choosing the model set", () => {
  const sets = [
    { name: "2.0.0-onnx.5", installed: true, bytes: 2.5e9 },
    { name: "2.0.0-onnx.4", installed: false, bytes: 3.3e9 },
  ];
  const page = (state: AppState) => {
    localStorage.setItem("ck.open.engine", JSON.stringify("onnx"));
    render(<EnginePage state={state} panelShown={true} narrow={false} glass={false} focus={null} sectionTasks={{}} hidePanel={() => {}} openSetup={() => {}} />);
  };

  it("lists each set as installed or with its download size; picking one not installed downloads it", async () => {
    const ck = mockCk({ setModelSet: () => Promise.resolve(), startInstall: () => Promise.resolve() });
    page(appState({ install: installState({ modelSets: sets }) }));
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Model set" });
    // loop: NOT-WORTH — two options
    expect([...select.options].map((o) => o.textContent)).toEqual(["2.0.0-onnx.5 (default) · installed", "2.0.0-onnx.4 · 3.3 GB download"]);
    expect(select.value).toBe("2.0.0-onnx.5");
    fireEvent.change(select, { target: { value: "2.0.0-onnx.4" } });
    expect(ck.setModelSet).toHaveBeenCalledWith("2.0.0-onnx.4");
    await waitFor(() => expect(ck.startInstall).toHaveBeenCalledWith());
  });

  it("switches to an installed set without a download", async () => {
    const ck = mockCk({ setModelSet: () => Promise.resolve() });
    page(appState({ settings: settings({ modelSet: "2.0.0-onnx.4" }), install: installState({ modelSets: [sets[0], { ...sets[1], installed: true }] }) }));
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Model set" });
    expect(select.value).toBe("2.0.0-onnx.4");
    fireEvent.change(select, { target: { value: "2.0.0-onnx.5" } });
    await waitFor(() => expect(ck.setModelSet).toHaveBeenCalledWith("2.0.0-onnx.5"));
    expect(ck.startInstall).not.toHaveBeenCalled();
  });

  it("review S2: with TensorRT on, the row says TensorRT jobs run 2.0.0-onnx.4-trt with either set", () => {
    mockCk();
    page(appState({ install: installState({ modelSets: sets }) }));
    expect(screen.queryByText(TRT_MODEL_SET_NOTE, { exact: false })).toBeNull();
    cleanup();
    page(appState({ settings: settings({ tensorrt: true }), install: installState({ modelSets: sets }) }));
    expect(screen.getByText(TRT_MODEL_SET_NOTE, { exact: false })).toBeTruthy();
  });

  it("can't be changed while a download runs", () => {
    mockCk();
    page(appState({ install: installState({ modelSets: sets, status: "running" }) }));
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Model set" }).disabled).toBe(true);
  });

  it("on macOS names the one set (no onnx.4 Core ML set) as text, not a one-choice list", () => {
    mockCk();
    const state = appState({ install: installState({ modelSets: [sets[0]] }) });
    page({ ...state, system: { ...state.system, platform: "darwin" } });
    expect(screen.queryByRole("combobox", { name: "Model set" })).toBeNull();
    expect(screen.getByText("Model set")).toBeTruthy();
    expect(screen.getByText("2.0.0-onnx.5 (default) · installed")).toBeTruthy();
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

describe("the app update notice (pinned above the page) and its task", () => {
  const offered = updateState({ status: "available", latest: "1.0.0-dev.2", size: 45_300_000 });
  const banner = (u: UpdateState, restartWait: string | null = null) => <UpdateBanner update={u} restartWait={restartWait} />;

  it("offered: the version and size in words; Download downloads it; Not now hides this step of this version, remembered", () => {
    const ck = mockCk({ installUpdate: async () => {} });
    const { unmount } = render(banner(offered));
    expect(screen.getByRole("status").textContent).toBe("1.0.0 Dev 2 is available, 45.3 MB.");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(ck.installUpdate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", { name: "App update" })).toBeNull();
    // remembered: a new start doesn't show it again
    unmount();
    const { rerender } = render(banner(offered));
    expect(screen.queryByRole("region", { name: "App update" })).toBeNull();
    // the next step shows again, and so does a newer version
    rerender(banner({ ...offered, status: "ready" }));
    expect(screen.getByRole("status").textContent).toBe("1.0.0 Dev 2 is ready: restart to use it.");
    rerender(banner({ ...offered, latest: "1.0.0-dev.3" }));
    expect(screen.getByRole("status").textContent).toBe("1.0.0 Dev 3 is available, 45.3 MB.");
  });

  it("Windows and macOS: the same notice without a size; Download asks the main process (it opens the release page); Back to stable says so", () => {
    const ck = mockCk({ installUpdate: async () => {} });
    const page = updateState({ status: "available", latest: "1.0.0-dev.2", opensPage: true });
    render(banner(page));
    expect(screen.getByRole("status").textContent).toBe("1.0.0 Dev 2 is available.");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(ck.installUpdate).toHaveBeenCalledTimes(1);
    cleanup();
    const state = appState({ update: updateState({ status: "current", current: "1.0.0-dev.2", latest: "1.0.0-dev.2", opensPage: true }) });
    render(<SettingsPage state={state} panelShown={true} narrow={false} glass={false} focus={{ section: "updates", n: 1 }} sectionTasks={{}} hidePanel={() => {}} />);
    expect(screen.getByText(UPDATE_PAGE_BACK_TO_STABLE)).toBeTruthy();
    expect(screen.queryByText("Installs the newest stable release over this dev build")).toBeNull();
  });

  it("downloading: the measured share as a bar and a number", () => {
    mockCk();
    render(banner({ ...offered, status: "downloading", progress: 0.42 }));
    expect(screen.getByRole("status").textContent).toBe("Downloading 1.0.0 Dev 2…");
    expect(screen.getByRole("progressbar", { name: "Downloading 1.0.0 Dev 2" }).getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByText("42%")).toBeTruthy();
  });

  it("ready: Restart now restarts; while work runs it waits and says why", () => {
    const ck = mockCk({ restartToUpdate: async () => {} });
    const ready = { ...offered, status: "ready" as const };
    const why = "The queue is running: stop it or let it finish, then restart.";
    const { rerender } = render(banner(ready, why));
    const restart = screen.getByRole("button", { name: "Restart now" }) as HTMLButtonElement;
    expect(restart.disabled).toBe(true);
    expect(screen.getByText(why)).toBeTruthy();
    expect(restart.getAttribute("aria-describedby")).toBe(screen.getByText(why).id);
    rerender(banner(ready));
    expect(restart.disabled).toBe(false);
    fireEvent.click(restart);
    expect(ck.restartToUpdate).toHaveBeenCalledTimes(1);
  });

  it("a failed install is an alert, verbatim, until dismissed; failing again shows it again; a failed check says nothing here", () => {
    mockCk();
    const error = "The update didn't install: no space left on device. Your current version is untouched.";
    const failed = { ...offered, status: "error" as const, errorFrom: "install" as const, error };
    const { rerender, container } = render(banner(failed));
    expect(screen.getByRole("alert").textContent).toContain(error);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(banner(failed));
    expect(screen.queryByRole("alert")).toBeNull();
    // tried again, failed again
    rerender(banner({ ...offered, status: "downloading", progress: 0.1 }));
    rerender(banner(failed));
    expect(screen.getByRole("alert").textContent).toContain(error);
    rerender(banner({ ...failed, errorFrom: "check", error: "Couldn't check for updates: offline" }));
    expect(container.innerHTML).toBe("");
  });

  it("the app: the notice above the page, a dot on App settings with the task's words, and its press opens Updates", async () => {
    const state: AppState = appState({ update: offered });
    mockCk({ getState: async () => state, onState: () => () => {}, onConsoleBlocks: () => () => {}, setVisible: () => {} });
    render(<App />);
    expect((await screen.findByRole("region", { name: "App update" })).textContent).toContain("1.0.0 Dev 2 is available, 45.3 MB.");
    const item = screen.getByRole("button", { name: /App settings/ });
    expect(item.getAttribute("aria-description")).toBe("Waiting: 1.0.0 Dev 2 is available, 45.3 MB");
    expect(item.querySelector(".task")).not.toBeNull();
    // nothing waiting elsewhere
    expect(screen.getByRole("button", { name: /^Queue/ }).querySelector(".task")).toBeNull();
    fireEvent.click(item);
    const updates = await screen.findByRole("button", { name: /^Updates/ });
    expect(updates.getAttribute("aria-expanded")).toBe("true");
    expect(updates.textContent).toContain("Waiting: 1.0.0 Dev 2 is available, 45.3 MB");
    // Not now hides the notice; the task (and its dot) stays until it is done
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", { name: "App update" })).toBeNull();
    expect(item.querySelector(".task")).not.toBeNull();
  });
});

describe("every task's section header shows its dot", () => {
  it("App settings → Storage: a missing cache drive (and Updates beside it)", () => {
    mockCk();
    const state = appState({ cacheMissing: "/media/scratch", update: updateState({ status: "ready", latest: "1.0.0-dev.2" }) });
    const sectionTasks = dots(tasksOf(state)).sections;
    render(<SettingsPage state={state} panelShown={true} narrow={false} glass={false} focus={null} sectionTasks={sectionTasks} hidePanel={() => {}} />);
    const storage = screen.getByRole("button", { name: /^Storage/ });
    expect(storage.textContent).toContain("Waiting: Drive not available for the cache folder: /media/scratch");
    expect(storage.querySelector(".task")).not.toBeNull();
    expect(screen.getByRole("button", { name: /^Updates/ }).querySelector(".task")).not.toBeNull();
    expect(screen.getByRole("button", { name: /^Appearance/ }).querySelector(".task")).toBeNull();
  });
});

// BACKLOG row 171: NorthXL's GPU card on the Engine page (its order: name in the header, Usage bar, memory bar, then
// temperature, fan, clock, power); a reading the card doesn't give is left out, never shown as 0
describe("the Engine page's graphics card (NorthXL's GPU card)", () => {
  const gpu = { name: "NVIDIA GeForce RTX 5080", totalMb: 16303, usedMb: 7628, utilization: 42, processes: [], at: 0 };
  const show = (g: object, queueRunning = true) => {
    mockCk();
    render(
      <EnginePage
        state={appState({ queueRunning, gpu: g as AppState["gpu"] })}
        panelShown={false}
        narrow={false}
        glass={false}
        focus={null}
        sectionTasks={{}}
        hidePanel={() => {}}
        openSetup={() => {}}
      />,
    );
  };
  it("shows the card in the header, usage and memory as bars, then temperature, fan, clock and power", () => {
    show({ ...gpu, tempC: 43, fanPct: 30, clockMhz: 2662, powerW: 52.53 });
    expect(screen.getByRole("heading", { name: "Graphics card · NVIDIA GeForce RTX 5080" })).toBeTruthy();
    const usage = screen.getByRole("progressbar", { name: "Usage" });
    expect(usage.getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Memory" }).getAttribute("aria-valuenow")).toBe("7628");
    expect(screen.getByText("7.4 GiB / 15.9 GiB")).toBeTruthy();
    // loop: NOT-WORTH — four readings in a test
    expect(screen.getAllByTestId("gpu-reading").map((e) => e.textContent)).toEqual(["43 °C", "Fan 30%", "2662 MHz", "53 W"]);
  });
  it("keeps the Usage bar in the accent colour at a keying job's ~100 %, never the heat tint (red means an error here)", () => {
    show({ ...gpu, utilization: 100 });
    const bar = screen.getByRole("progressbar", { name: "Usage" }).closest(".gpu-bar") as HTMLElement;
    expect(bar.classList.contains("heat")).toBe(false);
    expect(bar.style.getPropertyValue("--heat")).toBe("");
  });
  it("leaves out each reading the card doesn't give", () => {
    show({ ...gpu, tempC: 51, clockMhz: 1470 });
    // loop: NOT-WORTH — two readings in a test
    expect(screen.getAllByTestId("gpu-reading").map((e) => e.textContent)).toEqual(["51 °C", "1470 MHz"]);
    expect(screen.queryByText(/Fan|W$/)).toBeNull();
    cleanup();
    show(gpu);
    expect(screen.queryAllByTestId("gpu-reading")).toEqual([]);
  });
  it("rule 11: shows no readings while no job runs (the last reading isn't kept on screen)", () => {
    show({ ...gpu, tempC: 43 }, false);
    expect(screen.getByRole("heading", { name: "Graphics card" })).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText(/nothing is read while idle/)).toBeTruthy();
  });
});

// backlog row 166: AMD is on by default, declared untested on a real AMD card (Marcy 2026-10-29) wherever an AMD user meets it
describe("AMD cards: declared untested", () => {
  const ISSUES = "https://github.com/MarcelineVPQ/corridorkey-desktop/issues";
  const engine = (state: AppState, open: string) => {
    localStorage.setItem("ck.open.engine", JSON.stringify(open));
    render(<EnginePage state={state} panelShown={true} narrow={false} glass={false} focus={null} sectionTasks={{}} hidePanel={() => {}} openSetup={() => {}} />);
  };
  const declarations = () => screen.queryAllByText(AMD_UNTESTED, { exact: false });

  it("the setup step that offers the AMD runtime says so, with a link to the GitHub issues", () => {
    mockCk();
    render(
      <SetupPage
        state={appState({ rustEngine: { ok: false, problems: [] }, install: installState({ amd: true, needRuntime: true, needModels: true, bytes: 1e9 }) })}
        openQueue={() => {}}
        openGuide={() => {}}
      />,
    );
    expect(declarations()).toHaveLength(1);
    expect(screen.getByRole("link", { name: "GitHub issues" }).getAttribute("href")).toBe(ISSUES);
    expect(screen.getByRole("link", { name: "GitHub issues" }).getAttribute("target")).toBe("_blank");
  });

  it("the Engine page says so by the graphics card, in Runtime and models (installed too) and in TensorRT", () => {
    mockCk();
    const state = appState({ install: installState({ amd: true }), tensorrt: { ...appState().tensorrt, supported: false } });
    engine({ ...state, system: { ...state.system, platform: "linux" } }, "install");
    // the main area's Graphics card block and the open Runtime and models section
    expect(declarations()).toHaveLength(2);
    cleanup();
    engine({ ...state, system: { ...state.system, platform: "linux" } }, "tensorrt");
    expect(declarations()).toHaveLength(2);
    expect(screen.getByText(/on this AMD graphics card CorridorKey runs through AMD's MIGraphX/)).toBeTruthy();
  });

  it("NVIDIA, Windows, macOS and CPU-only setups show no AMD declaration", () => {
    mockCk();
    render(
      <SetupPage state={appState({ rustEngine: { ok: false, problems: [] }, install: installState({ needRuntime: true, needModels: true, bytes: 1e9 }) })} openQueue={() => {}} openGuide={() => {}} />,
    );
    expect(declarations()).toHaveLength(0);
    expect(screen.getByText(/GPU runtime, /)).toBeTruthy();
    cleanup();
    engine(appState(), "install");
    expect(declarations()).toHaveLength(0);
    expect(screen.queryByRole("link", { name: "GitHub issues" })).toBeNull();
  });
});

describe("a job that found no TensorRT engine (1.0.0-dev.7)", () => {
  const tech = { provider: "cuda", precision: "fp16", tensorrtRequested: true, fallbacks: {}, range: null, cache: null, notAsked: null, modelSet: null, modelsDir: null };
  const hd = (fallbackReason: string | null, fallbacks: Record<string, string> = {}) =>
    job("a", { status: "done", clip: clipInfo("a", { width: 1920, height: 1080 }), tech: { ...tech, fallbackReason, fallbacks } });
  const idle = { status: "done" as const, ranges: [], startedAt: null, note: null };
  const NOT_BUILT = "TensorRT for this resolution range isn't built yet";

  it("offers Build it now in plain words, with no build time (none is measured for the range it builds), and starts that size's build", () => {
    const ck = mockCk({ trtSize: () => Promise.resolve() });
    render(<JobView job={hd(NOT_BUILT)} prebuild={idle} trtOn />);
    // the main line: no ranges or windows; never a silent CUDA run
    expect(screen.getByText("TensorRT isn't built for this clip yet, so this run used CUDA")).toBeTruthy();
    // review 2026-10-29 M3: a shorter range's time was shown as this build's
    expect(screen.queryByText(/minute/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Build it now/ }));
    expect(ck.trtSize).toHaveBeenCalledWith("build", { label: "a", width: 1920, height: 1080 });
  });

  it("offers it too where the size is built only for shorter windows (the engine's reason in the quieter line)", () => {
    mockCk();
    const why = "TensorRT for this resolution is built for a window of 2 frames; this job's automatic window is 4";
    render(<JobView job={hd(why)} prebuild={idle} trtOn />);
    expect(screen.getByText("TensorRT isn't built for this clip yet, so this run used CUDA")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Build it now/ })).toBeTruthy();
    expect(screen.getByText(new RegExp(`Why: ${why}`))).toBeTruthy();
  });

  it("review 2026-10-29: no button where a build can't help (a busy card), and none while TensorRT is off (the tile says how to turn it on)", () => {
    mockCk();
    const busy = render(
      <JobView job={hd("the graphics card is busy: 9.0 GB of graphics memory is free, too little for the TensorRT engines built for this size, so this run used CUDA")} prebuild={idle} trtOn />,
    );
    expect(screen.queryByRole("button", { name: /Build it/ })).toBeNull();
    expect(screen.getByText(/the graphics card is busy/)).toBeTruthy();
    busy.unmount();
    render(<JobView job={hd(NOT_BUILT)} prebuild={idle} trtOn={false} />);
    expect(screen.queryByRole("button", { name: /Build it/ })).toBeNull();
    expect(screen.getByText(/turn it on in Engine settings → TensorRT/)).toBeTruthy();
  });

  it("review 2026-10-29: a build that ran short of memory says so and offers to build again; a network with no tactic is offered a build too", () => {
    const ck = mockCk({ trtSize: () => Promise.resolve() });
    const error =
      "the graphics card didn't have enough memory to build stage 1 for 1920×1080 (9.0 of its 15.5 GB was free when the build started). What was built is kept: building again while more of the card is free may finish it (Sonata was using the graphics card when it started)";
    const failed = {
      status: "error" as const,
      ranges: [{ label: "a", width: 1920, height: 1080, state: "failed" as const, piece: null, range: null, fallbacks: {}, error }],
      startedAt: null,
      note: null,
    };
    const f = render(<JobView job={hd(NOT_BUILT)} prebuild={failed} trtOn />);
    expect(screen.getByText(/The last build couldn't finish: the graphics card didn't have enough memory/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Build it again/ }));
    expect(ck.trtSize).toHaveBeenCalledWith("build", { label: "a", width: 1920, height: 1080 });
    f.unmount();
    // review 2026-10-29 N-N5: short of memory with no other program on the card: the reason, and no button
    const alone = { ...failed, ranges: [{ ...failed.ranges[0], cardWasFree: true }] };
    const a = render(<JobView job={hd(NOT_BUILT)} prebuild={alone} trtOn />);
    expect(screen.queryByRole("button", { name: /Build it/ })).toBeNull();
    expect(screen.getByText(/The last build couldn't finish/)).toBeTruthy();
    expect(screen.getByText(/No other program was using the graphics card when it started/)).toBeTruthy();
    a.unmount();
    render(<JobView job={hd(null, { stage1: "build: Could not find any implementation for node X" })} prebuild={idle} trtOn />);
    expect(screen.getByRole("button", { name: /Build it now/ })).toBeTruthy();
    expect(screen.queryByText(/Why:/)).toBeNull();
  });

  it("says it builds while it does, and no button where a build can't help (outside TensorRT's sizes)", () => {
    mockCk();
    const running = {
      status: "running" as const,
      ranges: [{ label: "a", width: 1920, height: 1080, state: "building" as const, piece: "stage1", range: null, fallbacks: {}, error: null }],
      startedAt: 0,
      note: null,
    };
    const { unmount } = render(<JobView job={hd(NOT_BUILT)} prebuild={running} trtOn />);
    expect(screen.queryByRole("button", { name: /Build it now/ })).toBeNull();
    expect(screen.getByText(/It builds in the background now/)).toBeTruthy();
    unmount();
    const outside = render(<JobView job={hd("6144x3328 is outside the TensorRT ranges")} prebuild={idle} trtOn />);
    expect(screen.queryByRole("button", { name: /Build it now/ })).toBeNull();
    outside.unmount();
    // after the build: the next run uses it; asked while the queue runs: it builds once the queue stops
    const range = { label: "a", width: 1920, height: 1080, piece: null, fallbacks: {}, error: null };
    const built = { ...idle, ranges: [{ ...range, state: "done" as const, range: "h1024-1280_w1792-2176_t1-24_f1-4" }] };
    const after = render(<JobView job={hd(NOT_BUILT)} prebuild={built} trtOn />);
    expect(screen.getByText("Built for this size now: the next run of this clip uses TensorRT.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Build it now/ })).toBeNull();
    after.unmount();
    const paused = { ...idle, status: "paused" as const, ranges: [{ ...range, state: "todo" as const, range: null }] };
    render(<JobView job={hd(NOT_BUILT)} prebuild={paused} trtOn />);
    expect(screen.getByText(/builds in the background once the queue stops/)).toBeTruthy();
  });

  it("review 2026-10-29 S1: a waiting clip of a built size isn't promised TensorRT (an earlier build or a busy card runs it on CUDA)", () => {
    const j = job("a", { clip: clipInfo("a", { width: 1920, height: 1080 }) });
    const plan = trtPlanFor(j, trtState({ on: true, ready: true, built: ["h1024-1280_w1792-2176_t1-2_f1-2"] }))!;
    expect(plan.status).toBe("On · built for this size");
    expect(plan.text).not.toMatch(/so this clip runs on TensorRT/);
    expect(plan.text).toBe(
      "Built for 1920×1080 (windows up to 2 frames). If this clip still runs on CUDA (a longer window than built, or the graphics card busy), its page says why, and offers Build it now where a build helps.",
    );
  });
});

describe("TensorRT sizes (Engine settings)", () => {
  it("2026-10-29: a size built for other model files says it needs a rebuild, and Build now and its tick rebuild it", () => {
    const ck = mockCk({ trtPrebuild: () => Promise.resolve(), trtSize: () => Promise.resolve() });
    const four = { label: "4K DCI", width: 4096, height: 2160 };
    const trt = trtState({
      on: true,
      ready: true,
      built: [],
      prebuild: { status: "idle", ranges: [{ ...four, state: "todo", piece: null, range: null, fallbacks: {}, error: null }], startedAt: null, note: null },
      onDisk: [
        { range: "h1792-2176_w3584-4096_t1-8_f1-4", bytes: 2_500_000_000, buildSeconds: 300, stale: true },
        { range: "h1024-1280_w1792-2176_t1-24_f1-4", bytes: 2_500_000_000, buildSeconds: 300, stale: true },
      ],
    });
    render(<TrtBox trt={trt} inst={installState()} platform="linux" />);
    // loop: NOT-WORTH — the size notes on one page
    const notes = screen.getAllByText(/built for other models · needs a rebuild \(the model set changed\)/);
    expect(notes).toHaveLength(2);
    expect(screen.queryByText(/· built \(/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Build now/ }));
    expect(ck.trtPrebuild).toHaveBeenCalledWith("start");
    // HD isn't chosen: its tick is off, and ticking it builds it
    // loop: NOT-WORTH — two rows in a test
    const ticks = notes.map((n) => n.closest("li")!.querySelector("input")!);
    // loop: NOT-WORTH — as above
    expect(ticks.map((t) => t.checked).sort()).toEqual([false, true]);
    // loop: NOT-WORTH — as above
    const hd = ticks.find((t) => !t.checked)!;
    fireEvent.click(hd);
    expect(ck.trtSize).toHaveBeenCalledWith("add", expect.objectContaining({ height: 1080 }));
  });
});
