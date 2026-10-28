// Sentences shown in more than one place, one definition each (shared by the main process and the pages), so
// the setup, the Engine page, the rail and the tasks never drift apart. Written as they read on their own;
// lowerFirst() for where one continues a line (an error after "stopped: ").
import { mbOrGbBytes } from "./units";

/** The sentence with its first letter in lower case, for use inside a line. */
export function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** The first-run install: the setup's step 1 and the Engine page's task. */
export const INSTALL_STEP = "Download the GPU runtime and the CorridorKey models";
/** TensorRT's parts install on top of the runtime and models (the TensorRT box, and the install's refusal). */
export const INSTALL_FIRST = "Install the GPU runtime and the CorridorKey models first";
/** The engine failed to start: the Engine page's notice and the task's text. */
export const ENGINE_FAILED = "The engine didn't start";
/** The idle engine (it quits with the queue): the Engine page's state and the rail's engine line. */
export const NO_VRAM_HELD = "no graphics memory held";
/** A section's status while its download runs (the runtime and models, TensorRT). */
export const downloadingStatus = (pct: number) => `downloading ${pct}%`;
/** A clip the app can't read: its queue status, its notice and its task. */
export const CANT_READ_CLIP = "Can't read this clip";
/** A job that has run: its settings are shown as they were (said once, in the panel's subtitle). */
export const AS_USED = "As used for this run";
/** Storage can't be removed while something uses it (the button's tooltip, the main process's refusal). */
export const NOT_WHILE_BUSY = "Not while the queue or the download runs";
/** A version as people read it: "1.0.0-dev.2" is "1.0.0 Dev 2" (App settings, About, the update notice and its task). */
export function versionText(v: string): string {
  const m = /^(\d+\.\d+\.\d+)-dev\.(\d+)$/.exec(v);
  return m ? `${m[1]} Dev ${m[2]}` : v;
}
/** An update offered, with its download's size (the pinned update notice and its App settings task). */
export const updateAvailableText = (version: string, bytes: number | null) => `${versionText(version)} is available${bytes ? `, ${mbOrGbBytes(bytes)}` : ""}`;
/** An update installed beside this copy (the pinned update notice and its App settings task). */
export const updateReadyText = (version: string) => `${versionText(version)} is ready: restart to use it`;
/** A build without a release channel (App settings, Updates; and the check's refusal). */
export const NO_RELEASE_CHANNEL = "No release channel is set up in this build";
