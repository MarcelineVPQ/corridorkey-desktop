# Your first key

This page walks through one job, from adding a clip to finding the results. It assumes the setup is done
([Linux](Installing-on-Linux), [Windows](Installing-on-Windows)).

## Finding your way around

The **rail** on the right takes you to the pages: **Queue**, **Engine**, **Console**, **App settings** and **About**
(which has the in-app guide). Hover it for names, or press **Ctrl+B** to keep it open. A yellow dot on an icon means
something is waiting there; pressing it takes you to it. Pressing the page you're on shows or hides its settings panel.

### Queue

Your clips, their settings and their results: the rest of this page.

### Engine

The CorridorKey engine, its files and the graphics card: the **Engine program**, the **Models folder** and the
**ONNX Runtime library** in use (each **Automatic**, the newest found, or one you choose), ffmpeg, and on Linux
[TensorRT](TensorRT). [Troubleshooting](Troubleshooting#the-engine) explains its messages.

### Console

A command line inside the app, for power users: see [Console](Console).

### App settings

- **Appearance:** **Theme** (System, Light, Dark, or Desktop: your desktop's own colours), **Accent color**
  (CorridorKey green or your desktop's accent) and **Glass** (Liquid Glass on the rail and panels).
- **Results:** where results go (step 4 below).
- **Console:** the folders the Console may write in besides the results and cache folders ([Console](Console)).
- **Graphics memory:** the memory limit new clips start with ([Graphics memory](Graphics-Memory-and-the-Window)).
- **Updates:** the channel and automatic checks ([Updates and channels](Updates-and-Channels)).
- **Storage:** what the app keeps on this PC, and the cache folder ([Uninstall](Uninstall)).

### About

The in-app guide, the changes, the credits and licence, and the third-party notices.

## 1. Add clips

Open **Queue** and drop clips anywhere on the window, or use the two buttons:

- **Add clips…** for video files: `.mp4`, `.mov`, `.mkv`, `.avi`, `.mxf`, `.webm`, `.m4v`.
- **Add folder…** for a frame sequence (a folder of `.exr`, `.png`, `.jpg` or `.jpeg` frames) or a folder of
  clips (the video files directly inside it are added, one level deep).

A shot folder laid out the way the original CorridorKey's launcher expects (`<shot>/Input` with the frames, and
optionally `<shot>/AlphaHint`) works as it is. Frames are read in natural order (`f_2` before `f_10`), whatever the
case of the extension.

Each clip gets a row with a thumbnail, its size, frame rate and length. If a matte for it sits next to it, named
the right way, the app finds it and selects it (see [Hints](Hints)). If the app can't read a clip, the row says
"Can't read this clip" and why (see [Troubleshooting](Troubleshooting#cant-read-this-clip)).

## 2. Set up each clip

Pick a clip; its settings are in the panel on the right. Every clip has its own settings, and a new clip starts
from the settings you used last.

| Section | What it does |
| --- | --- |
| **Hint** | No hint, a first-frame matte or a hint video, and how far to trust it. See [Hints](Hints). |
| **Outputs** | Which files (Alpha, Foreground, Checker, Cutout), the format (Video or EXR sequence), the codec, despill. See [Outputs](Outputs). |
| **Frame folder** | Frame sequences only: the frame rate (24 by default) and whether the frames are scene-linear. A folder of EXR frames starts scene-linear, PNG/JPEG display-coded; once you change it, new frame folders start with your choice. |
| **Internal resolution** | **Full** runs the networks at the clip's own size; **¾**, **½** and **¼** run them smaller (the original's `--model_scale`, the plugin's Internal Resolution): faster and lighter, with less detail in the edges. The result is resized back to the clip's size. |
| **Input precision** | **Bit depth**, off by default: every input is read exactly as CorridorKey 2.0 reads it, byte for byte. On reads 10/12-bit video and 16-bit PNG at full depth, which differs from CorridorKey 2.0 ([README](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/README.md#deep-input-10--and-12-bit-plates-reach-the-model-in-full-10)). |
| **Linear exposure** | Video clips only: brightness and contrast (around the **Contrast pivot**, 0.18 = mid grey) on the frames the networks see, for an under- or over-exposed plate. The foreground is turned back by the exact inverse, so the outputs keep the clip's own exposure. |
| **Graphics memory** | The temporal window and the memory limit. Automatic is right for most clips. See [Graphics memory and the window](Graphics-Memory-and-the-Window). |
| **TensorRT** | Linux only: whether this clip will run on TensorRT, and why not. See [TensorRT](TensorRT). |

Each section's header shows its current choice, so you can see a clip's setup at a glance.

## 3. Start the queue

Press **Start queue**. Clips run one at a time, in order. If the button is greyed out, hover it for the reason (for
example "Install ffmpeg first (Engine page)" or "Add a clip that's ready to run").

While a clip runs, its page shows:

- **Progress:** the stages (Starting the engine, Loading the model, Reading the clip, Motion features (RVM),
  Foundation features in low-memory mode, Keying), **Frames written**, the **measured speed** and the elapsed time.
  Every number comes from the engine; nothing is guessed.
- **Technology for this run:** what it really ran on (CUDA or TensorRT, and the precision), and on Linux why
  TensorRT was or wasn't used.
- **Memory used for this run:** the temporal window the engine really used, whether low-memory mode was on, the free
  graphics memory it saw when it started, the limit, and the runtime's peak estimate.
- **Engine log:** the engine's own output.

If other programs are using the graphics card, the Queue page names them: the automatic window picks a smaller
window when less memory is free, and both run slower together.

**Stop** cancels the running clip (its partly written files are removed) and leaves the waiting clips in the queue.
A failed or cancelled clip has **Run again**.

The engine runs only while the queue does: when the queue is done it quits and holds no graphics memory.

## 4. Find the results

By default the results go next to each clip, in a folder called `out_<clip>`. (For a shot folder with an `Input`
folder inside, it goes next to the shot folder.) If two clips in the queue have the same name, each gets its own
folder. To collect everything in one place instead, use **App settings → Results → Where results go**; it applies to
clips added from then on.

The clip's page shows **Results:** with the folder, and when the clip is done, a still of each video output's middle
frame and the list of files, each with **Show in folder**.

In the results folder you'll find:

- the outputs you chose, named after the clip, for example `shot01_alpha.mp4` and `shot01_fg.mp4`, or EXR folders
  (see [Outputs](Outputs));
- `<clip>_settings.txt`: the settings the engine used, written by the engine;
- `<clip>_log.txt`: the job log, written by the app when the job ends.

While a job runs, the engine writes into a hidden `.corridorkey-partial` folder inside the results folder, and the
app moves the files into place only when the job has finished. So a results folder never holds half a job, and
earlier results in it are left alone if a job fails.

## The job log

Every job's log is saved next to its results when it ends:

| File | When |
| --- | --- |
| `<clip>_log.txt` | the job finished |
| `<clip>_log_failed.txt` | the job failed |
| `<clip>_log_cancelled.txt` | you stopped it |

So a failed retry never overwrites the log of a finished run. The log starts with what ran the job (the
"Technology for this run" and memory details, as the page shows them), then the whole engine log, then, if it
failed, the engine's last error output. **Copy log** on the clip's page copies the same text, which is the most
useful thing to attach to a bug report.
