// The app update, pinned above every page (the DS5 app's update notices, adapted): offered, downloading, installed and
// waiting for a restart, or its install failed. Literal words: each state says what is happening or what went wrong.
// Not now hides one step of one version, remembered (tasks.ts updateNoticeKey): the next step or a newer version shows
// again. A failed install stays until dismissed and shows again if it fails again; a failed check isn't said here (App
// settings → Updates says it, and a scheduled one stays quiet). The rail's dot follows the task, not these dismissals.
// Restart now waits for the same work the main process waits for (AppState.restartWait), and says what that is.
// Idle cost: none (renders with the state push; no timers).
import { useId, useState } from "react";
import type { UpdateState } from "../shared/types";
import { updateNoticeKey } from "../shared/tasks";
import { updateAvailableText, updateReadyText, versionText } from "../shared/texts";
import { ProgressBar } from "./ProgressBar";
import { usePref } from "./prefs";

/** The dismissed update notices' keys (localStorage), newest last. */
export const DISMISSED_UPDATES = "ck.dismissedUpdates";
/** How many are kept: a few versions' steps (older ones can't show again anyway). */
const KEEP = 10;

export function UpdateBanner({ update: u, restartWait }: { update: UpdateState; restartWait: string | null }) {
  const [stored, setDismissed] = usePref<string[]>(DISMISSED_UPDATES, []);
  const dismissed = Array.isArray(stored) ? stored : [];
  const failed = u.status === "error" && u.errorFrom === "install" ? u.error : null;
  // the failure the user dismissed; forgotten once the update moves on, so failing again shows again (set while
  // rendering: React's pattern for state that follows a prop)
  const [closed, setClosed] = useState<string | null>(null);
  if (!failed && closed !== null) setClosed(null);
  const waitId = useId();

  if (failed) {
    if (closed === failed) return null;
    return (
      <section className="notice error update-banner" role="alert" aria-label="App update">
        <p>{failed}</p>
        <div className="btn-row">
          <button type="button" className="btn small" onClick={() => setClosed(failed)}>
            Dismiss
          </button>
        </div>
      </section>
    );
  }

  const key = updateNoticeKey(u);
  if (!key || !u.latest || dismissed.includes(key)) return null;
  // loop: NOT-WORTH — ≤ KEEP keys, on a press
  const notNow = () => setDismissed((old) => [...(Array.isArray(old) ? old : []).filter((k) => k !== key), key].slice(-KEEP));
  const notNowButton = (
    <button type="button" className="btn small" onClick={notNow}>
      Not now
    </button>
  );
  const version = versionText(u.latest);

  if (u.status === "downloading") {
    const pct = Math.floor((u.progress ?? 0) * 100);
    return (
      <section className="notice update-banner" aria-label="App update">
        {/* the sentence is announced once; the bar's value isn't re-read at every step */}
        <p role="status">Downloading {version}…</p>
        <div className="update-progress">
          <ProgressBar label={`Downloading ${version}`} value={pct} max={100} />
          <span className="hint-text">{pct}%</span>
        </div>
        <div className="btn-row">{notNowButton}</div>
      </section>
    );
  }

  if (u.status === "ready")
    return (
      <section className="notice update-banner" aria-label="App update">
        <p role="status">{updateReadyText(u.latest)}.</p>
        {restartWait && (
          <p id={waitId} className="hint-text">
            {restartWait}
          </p>
        )}
        <div className="btn-row">
          <button
            type="button"
            className="btn small primary"
            disabled={restartWait !== null}
            aria-describedby={restartWait ? waitId : undefined}
            title={restartWait ?? undefined}
            onClick={() => void window.ck.restartToUpdate()}
          >
            Restart now
          </button>
          {notNowButton}
        </div>
      </section>
    );

  // offered
  return (
    <section className="notice update-banner" aria-label="App update">
      <p role="status">{updateAvailableText(u.latest, u.size)}.</p>
      <div className="btn-row">
        <button type="button" className="btn small primary" onClick={() => void window.ck.installUpdate()}>
          Download
        </button>
        {notNowButton}
      </div>
    </section>
  );
}
