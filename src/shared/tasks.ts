// The one task mechanism (Sonata's tasks-model.js, Marcy 2026-10-19: "the
// whole app works the same way for all things"). Anything that needs the user
// is a task here, and only here:
//   page     the rail item that shows the dot
//   section  the panel section it's about ('' = the page as a whole)
//   level    'task' (something to do) or 'error' (something went wrong)
//   text     what's waiting, in words: the rail tooltip, the section's status
//            line and the screen reader's "Waiting: …" (never color alone)
// The rail (a dot on the page's item), the panel (a dot on the section header)
// and a rail press (opens the page at the first waiting section) all read it.
// Tasks are derived from the app state, so they clear themselves when the
// state is fixed. Nothing else draws a dot or badge (the .task look).
import type { AppState, FfmpegState, InstallState, Job } from "./types";

/** The runtime or the models are missing from the data folder (what the install box offers to download). */
export function installMissing(install: InstallState): boolean {
  return install.needRuntime || install.needModels;
}

/** The first-run install is still to do: files missing and no engine ready (a PyTorch reference engine counts). */
export function installNeeded(s: { install: InstallState; engineKind: string | null }): boolean {
  return installMissing(s.install) && !s.engineKind;
}

/** Whether setup still has something to do (the setup page opens by itself at start while it does). */
export function setupNeeded(s: { install: InstallState; ffmpeg: FfmpegState; engineKind: string | null }): boolean {
  return installNeeded(s) || (s.ffmpeg.checked && !s.ffmpeg.ok);
}

// "setup" is the first start's page (pages/SetupPage.tsx): not on the rail, it opens by itself while setup has work
export type PageId = "queue" | "engine" | "settings" | "about" | "setup";

export interface Task {
  id: string;
  page: PageId;
  section: string;
  level: "task" | "error";
  text: string;
  // a queue task about one job (the page selects it)
  jobId?: string;
}

/** A waiting job that can't run as set up: its hint mode needs a file it doesn't have. */
export function missingInput(job: Job): string | null {
  if (job.status !== "waiting" || job.clip.probeError) return null;
  if (job.options.hintMode === "first-frame" && !job.options.hintFirstFrame) return "Choose the first-frame matte, or pick No hint";
  if (job.options.hintMode === "video" && !job.options.hintVideo) return "Choose the hint video, or pick No hint";
  return null;
}

export function tasksOf(state: AppState): Task[] {
  const tasks: Task[] = [];
  // the first-run install is what's missing (the engine's own setup task would only repeat it)
  // (while it runs there is nothing to do: no task at all)
  if (installNeeded(state)) {
    if (state.install.status !== "running")
      tasks.push({
        id: "install",
        page: "engine",
        section: "install",
        level: state.install.status === "error" ? "error" : "task",
        text: state.install.error ? `The install stopped: ${state.install.error}` : "Download the GPU runtime and the CorridorKey models",
      });
  }
  // no engine set up: the ONNX Runtime engine is the one to set up (the PyTorch checkout still works meanwhile)
  else if (!state.engineKind) tasks.push({ id: "engine-setup", page: "engine", section: "onnx", level: "task", text: state.rustEngine?.problems[0] ?? "Set up the CorridorKey engine" });
  // no usable ffmpeg: nothing can be read or written (the Engine page offers the install)
  if (state.ffmpeg.checked && !state.ffmpeg.ok && state.ffmpeg.problem) tasks.push({ id: "ffmpeg", page: "engine", section: "ffmpeg", level: "task", text: state.ffmpeg.problem });
  if (state.engine.status === "failed") tasks.push({ id: "engine", page: "engine", section: "", level: "error", text: `The engine didn't start: ${state.engine.error ?? "unknown error"}` });
  // loop: NOT-WORTH — a queue of tens of clips, on each state change (≤ 10/s while running)
  for (const job of state.jobs) {
    // a clip the app can't read (bug hunt 2026-10 A9): its reason is on the row; the user removes or replaces it
    if (job.clip.probeError && job.status === "waiting")
      tasks.push({ id: `unreadable:${job.id}`, page: "queue", section: "", level: "error", text: `${job.clip.name}: Can't read this clip (${job.clip.probeError})`, jobId: job.id });
    const need = missingInput(job);
    if (need) tasks.push({ id: `hint:${job.id}`, page: "queue", section: "hint", level: "task", text: `${job.clip.name}: ${need}`, jobId: job.id });
  }
  // loop: HOT-PATH-OK — the queue's jobs per state push (≤ 10/s while shown)
  const failed = state.jobs.filter((j) => j.status === "failed");
  if (failed.length)
    tasks.push({ id: "failed", page: "queue", section: "", level: "error", text: failed.length === 1 ? `${failed[0].clip.name} failed` : `${failed.length} clips failed`, jobId: failed[0].id });
  return tasks;
}

/** The clip a rail press on `page` selects: the first queue task about one clip, or null. */
export function jobToSelect(tasks: Task[], page: PageId): string | null {
  // loop: NOT-WORTH — a few tasks per rail click
  return page === "queue" ? (tasks.find((x) => x.page === page && x.jobId)?.jobId ?? null) : null;
}

/** The dots: every waiting text per page (one per line), the first text per page/section, and each page's target section. */
export function dots(tasks: Task[]): { pages: Partial<Record<PageId, string>>; sections: Record<string, string>; targets: Partial<Record<PageId, string>> } {
  const pages: Partial<Record<PageId, string>> = {};
  const sections: Record<string, string> = {};
  const targets: Partial<Record<PageId, string>> = {};
  // loop: NOT-WORTH — N ≤ the queue's length; on change
  for (const t of tasks) {
    pages[t.page] = pages[t.page] ? `${pages[t.page]}\n${t.text}` : t.text;
    if (t.section) {
      const k = `${t.page}/${t.section}`;
      if (!sections[k]) sections[k] = t.text;
      if (!targets[t.page]) targets[t.page] = t.section;
    }
  }
  return { pages, sections, targets };
}
