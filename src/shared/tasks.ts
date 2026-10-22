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
import type { AppState, Job } from "./types";

export type PageId = "queue" | "engine" | "settings" | "about";

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
  // no engine set up: the ONNX Runtime engine is the one to set up (the PyTorch checkout still works meanwhile)
  if (!state.engineKind) tasks.push({ id: "engine-setup", page: "engine", section: "onnx", level: "task", text: state.rustEngine?.problems[0] ?? "Set up the CorridorKey engine" });
  if (state.engine.status === "failed") tasks.push({ id: "engine", page: "engine", section: "", level: "error", text: `The engine didn't start: ${state.engine.error ?? "unknown error"}` });
  // loop: NOT-WORTH — a queue of tens of clips, on each state change (≤ 10/s while running)
  for (const job of state.jobs) {
    const need = missingInput(job);
    if (need) tasks.push({ id: `hint:${job.id}`, page: "queue", section: "hint", level: "task", text: `${job.clip.name}: ${need}`, jobId: job.id });
  }
  const failed = state.jobs.filter((j) => j.status === "failed");
  if (failed.length)
    tasks.push({ id: "failed", page: "queue", section: "", level: "error", text: failed.length === 1 ? `${failed[0].clip.name} failed` : `${failed.length} clips failed`, jobId: failed[0].id });
  return tasks;
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
