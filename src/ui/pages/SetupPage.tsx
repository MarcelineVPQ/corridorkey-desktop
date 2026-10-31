// Setup: the first start's three steps, each with its control and a tick when done (Marcy 2026-10-24: the
// app had no setup wizard or install guide, and needs one). Opens by itself at start while
// setup has something to do; the Engine page reopens it. Every tick comes from the app state, never a guess.
import { Check, FolderOpen, FolderPlus, ListVideo } from "lucide-react";
import type { ReactNode } from "react";
import type { AppState } from "../../shared/types";
import { installNeeded } from "../../shared/tasks";
import { INSTALL_STEP } from "../../shared/texts";
import { MainBlock } from "../panel/SplitView";
import { FfmpegBox, InstallBox } from "../setup/SetupParts";

function Step(props: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <MainBlock
      title={
        <>
          {/* an aria-label on a plain span isn't read: the words are in the heading, for screen readers only */}
          <span className={`step-n ${props.done ? "done" : ""}`} aria-hidden>
            {props.n}
          </span>
          <span className="sr-only">{`Step ${props.n}${props.done ? ", done" : ""}: `}</span>
          {props.title}
        </>
      }
    >
      {props.done && (
        <div className="check-line ok gap-bottom">
          <Check size={15} aria-hidden /> Done
        </div>
      )}
      {props.children}
    </MainBlock>
  );
}

export function SetupPage(props: { state: AppState; openQueue: () => void; openGuide: () => void }) {
  const { state } = props;
  const installed = !installNeeded(state);
  const ffmpegOk = state.ffmpeg.ok;
  const hasClips = state.jobs.length > 0;
  const allDone = installed && ffmpegOk && hasClips;
  return (
    <div className="page-body">
      <div className="page-bar">
        <h1>Set up CorridorKey</h1>
      </div>
      <div className="page-content">
        <p className="hint-text lead">
          Three steps, once. CorridorKey keys green and blue screen footage on your own graphics card: it needs its runtime and models, ffmpeg to read and write video, and your clips.
        </p>
        <Step n={1} title={INSTALL_STEP} done={installed}>
          {!installed && <InstallBox inst={state.install} />}
        </Step>
        <Step n={2} title="ffmpeg, for reading and writing video" done={ffmpegOk}>
          {!ffmpegOk && <FfmpegBox ff={state.ffmpeg} />}
        </Step>
        <Step n={3} title="Add your first clip" done={hasClips}>
          {!hasClips && (
            <>
              <p className="hint-text">A video file, a folder of frames (EXR, PNG or JPEG) or a folder of clips. Drop them anywhere on this window, or:</p>
              <div className="btn-row">
                <button type="button" className="btn small primary" onClick={() => void window.ck.pickClips("files")}>
                  <FolderOpen size={14} /> Add clips…
                </button>
                <button type="button" className="btn small" onClick={() => void window.ck.pickClips("folder")}>
                  <FolderPlus size={14} /> Add folder…
                </button>
              </div>
            </>
          )}
        </Step>
        {allDone ? (
          <section className="notice">
            <h3>All set</h3>
            <div className="hint-text">Pick a clip in the queue to choose its hint and outputs, then press Start queue.</div>
            <button type="button" className="btn small primary gap-top" onClick={props.openQueue}>
              <ListVideo size={14} /> Open the queue
            </button>
          </section>
        ) : (
          <p className="hint-text">
            Each step ticks itself when it's done.{" "}
            <button type="button" className="link-btn" onClick={props.openGuide}>
              Read the guide
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
