# Render-farm submitters

Example submitters for `corridorkey`, the command line ([docs/CLI.md](../docs/CLI.md): flags, frames, exit codes,
progress lines, the report). Every one keys **one whole shot per task** by default: that is the app's matte, bit for
bit. Chunks of a shot (`--frames` per task with `--preroll` / `--tail` warm-up frames) are near-identical, not
identical; how many warm-up frames make the seams invisible is not measured yet (the farm plan's phase 3), so
chunking is opt-in and its warm-up defaults to 0.

Every submitter needs, on each worker: the `corridorkey` command, the model set's folder (`--models`), ONNX
Runtime's library (`--ort`), ffmpeg for movie inputs, and an NVIDIA card. `corridorkey prepare` checks a worker.

The app's Console writes these for the clips in its queue, with their settings: `farm export <openjd|deadline|opencue|flamenco|shell>
--queue -o <folder>` (docs/CONSOLE.md "Farm export").

## OpenJD

AWS Deadline Cloud, or any Open Job Description runtime. Two job bundles, `jobtemplate-2023-09`:

- `openjd/corridorkey/template.yaml`: **one task per shot** (no frame range: the whole shot), then a `Verify` step
  (`corridorkey verify`, exit 9 when a frame is missing or cut).
- `openjd/corridorkey-chunked/template.yaml`: a frame range (`Frames`, such as `1001-1100`) in chunks with the
  `TASK_CHUNKING` extension (`CHUNK[INT]`, `CONTIGUOUS`), `Frames per task` (Deadline Cloud allows at most 150; the
  default 150 keys a range of up to 150 frames as one task), `Preroll` and `Tail` (0 by default), then `Verify` over
  the whole range.

The Key step runs `corridorkey render ... --progress-format openjd` (the monitor reads `openjd_progress:` and
`openjd_status:`), writes `corridorkey_report.json` (chunks: `corridorkey_report.<range>.json`) into the output
folder, and cancels with `NOTIFY_THEN_TERMINATE`: corridorkey stops after the frame or window it is on, puts no
frame at a final name and exits 143. Temporary files go in the session's working folder (corridorkey reads
`OPENJD_SESSION_WORKING_DIR`).

Parameters carry `userInterface` hints for Deadline Cloud's submitter: clip, output folder and file name
(`key.####.exr`), outputs (`alpha,fg`), scene-linear plates, frames already there, low-memory mode, the command, the
models folder and the ONNX Runtime library (paths on the workers; no default, since the app's install is per user).

Host requirements: Linux or Windows, `amount.worker.gpu` ≥ 1, `amount.worker.gpu.memory` ≥ 8192 MiB. That is the
README's floor ("8 GB or more"); the engine picks its temporal window from the card's free memory, and the measured
peaks are in the README's Speed section (model set onnx.4, CUDA, a 12 GB budget on a 16 GB card: 9.07 GiB at
1280×1080, 9.29 GiB at 4K). Edit the number for your cards: it is fixed in the template, not a job parameter, because
a format string there needs the `FEATURE_BUNDLE_1` extension, which we haven't confirmed Deadline Cloud accepts.

Two limits of the 2023-09 template language, without a shell (which wouldn't run on both systems):

- **Frames already there** is `--skip-existing` (default: nothing to do when every frame is there and whole, else
  the shot or chunk is keyed again) or `--overwrite`. The command line's own default, refusing (exit 4), isn't
  offered: the template can't leave a flag out. Resubmitting changed settings to the same folder with
  `--skip-existing` keeps the old frames: pick `--overwrite` then.
- The checkboxes (scene-linear, low-memory) go in through a small `--job` options file the template writes
  (`{"options": {"frame_dir_linear": …, "low_vram": …}}`, docs/CLI.md `--job`).

```sh
openjd check farm/openjd/corridorkey/template.yaml
openjd run farm/openjd/corridorkey/template.yaml --step Verify --run-dependencies \
  -p Input=/plates/sh010.####.exr -p OutputDir=/key/sh010 -p Linear=true \
  -p Models=/opt/corridorkey/models/2.0.0-onnx.4 -p OnnxRuntime=/opt/corridorkey/runtime/libonnxruntime.so.1.31.0
deadline bundle submit farm/openjd/corridorkey          # or: deadline bundle gui-submit farm/openjd/corridorkey
```

**Tested here** (2026-10-26, `openjd-cli` 0.8.0 / `openjd-model` 0.13.0): `openjd check` passes on both templates;
`openjd summary` lists Key and Verify; `openjd run` of both on a generated 6-frame 256×256 movie on the CPU
(`CK_ENGINE_DEVICE=cpu`, `CK_ENGINE_PRECISION=fp16`, no graphics card), the app's model set 2.0.0-onnx.4: the
per-shot bundle keyed 12 frames (alpha + fg) in one task and Verify passed (9 s); the chunked bundle with
`Frames=1001-1006`, 3 per task, preroll 2 and tail 2 ran two chunks (1001-1003 keyed 1001-1005; 1004-1006 keyed
1002-1006) and Verify passed (16 s). **Not tested**: Deadline Cloud itself (no account here): its submitter GUI,
job attachments, path mapping, worker host requirements, and cancel on a farm. A plate pattern
(`sh010.####.exr`) isn't a file job attachments can upload; that combination is unchecked.


## Deadline 10

`deadline10/CorridorKey/` is a Deadline 10 application plugin for `corridorkey` ([docs/CLI.md](../docs/CLI.md)). It is
a plugin of its own rather than Deadline's generic CommandLine plugin so that it can read the progress lines
`corridorkey` prints.

**Install.** Copy the `CorridorKey` folder to `<your repository>/custom/plugins/CorridorKey`. In the Monitor, open
Tools > Configure Plugins > CorridorKey and set:

- **corridorkey Executable**: where `corridorkey` lives on your workers. Give one path per line; each worker uses
  the first one it finds (for example the Windows, Linux and macOS install paths).
- **Model Set Folder** and **ONNX Runtime Library**: the `--models` and `--ort` paths, also one per line. Leave them
  blank to use each worker's `CK_ENGINE_MODELS` and `CK_ENGINE_ORT`.

Before the first job, run `corridorkey prepare` on each worker; it should exit 0.

**Submit.** Use one task per shot: set `ChunkSize` to the shot's length. One task per shot gives the app's matte, bit
for bit. The example in this folder keys frames 1001-1100 in one task:

```sh
deadlinecommand sh010_job_info.txt sh010_plugin_info.txt
```

Job options (the plugin info file):

| Option | Value |
|---|---|
| `InputPath` | `-i`: a movie, a frame folder, or `plate.####.exr` |
| `OutputPath` | `-o`: a folder, or `key.####.exr` |
| `Outputs` | `--outputs`, e.g. `alpha` or `alpha,fg` |
| `Preroll` | `--preroll`, for chunked jobs only |
| `MaxVram` | `--max-vram` GB |
| `ExtraArguments` | any other flags, e.g. `--linear --tail 8` |
| `Command` | `render`, or `verify` |

To check a render, submit a second job with `Command=verify`, the same options, the same `Frames`, `ChunkSize` equal
to the shot's length, and `JobDependencies=<the render job's ID>`. It exits 9 if a frame is missing or cut.

**What each task runs:**

```
corridorkey render -i … -o … -s <start> -e <end> --progress-format deadline --overwrite [--outputs …] [--preroll N] [--max-vram GB] [--models …] [--ort …] [--gpu N] [extra]
```

- `<start>` and `<end>` come from `GetStartFrame()` and `GetEndFrame()`.
- `--overwrite` is always passed, because a retried task finds the frames its earlier try already renamed into place.
- Paths go through Deadline's path mapping. On Windows workers each path is quoted by MSVC's rules (as Python's
  `subprocess.list2cmdline`), so a folder ending in `\` (`D:\shows\key\`) stays one argument; elsewhere paths go in
  double quotes.
- **GPU affinity.** When the worker or the job overrides GPU affinity (`OverrideGpuAffinity()`), the task gets
  `--gpu` set to one card from `GpuAffinity()`, picked by the task's thread number. Without an override,
  `corridorkey` uses the worker's `CUDA_VISIBLE_DEVICES` or its first card. `--gpu N` counts cards in CUDA's order.
  If Deadline's indices follow `nvidia-smi`'s order and the two orders differ on a worker, set
  `CUDA_DEVICE_ORDER=PCI_BUS_ID` in that worker's environment. We haven't checked which order Deadline's affinity
  indices use.
- **Progress and failures.**
  - `PROGRESS: N%` lines set the task's progress, and `STATUS: …` lines set its status.
  - On failure the CLI prints `ERROR: … (exit N, reason)` and then exits. The plugin keeps that line and fails the
    task in its exit-code check, naming the [exit code](../docs/CLI.md#exit-codes) and what it means.
  - The plugin doesn't fail the task from the stdout handler. Doing that would stop the process before it removes
    its hidden work folders.

**Chunks.** A smaller `ChunkSize` splits the shot across tasks. Each chunk starts its recurrent state cold, so a
chunk is only near-identical to the whole shot, even with `Preroll` warm-up frames. How many warm-up frames make the
seams invisible hasn't been measured yet (docs/CLI.md, "Warm-up"). Until it is, key one shot per task.

**What's tested here, and what isn't.**

- Tested on this PC (no Deadline here):
  - Both Python files pass `python3 -m py_compile`.
  - A throwaway run with stand-in `Deadline` modules checked the plugin's logic. It confirmed the built command
    line, the GPU pick, the progress, status and error handlers, and the exit-code failure. That stub run isn't in
    the repo.
  - The quoting: `farm/deadline10/test_quote.py` (`npm run test:farm`, part of `npm run check`) splits the quoted
    command line by MSVC's rules for Windows paths ending in `\`, with spaces, quotes and UNC shares.
- **Not yet run on a real Deadline.**
- The plugin uses these API names from the Deadline 10 scripting reference and Thinkbox's own plugins:
  - `DeadlinePlugin`, `PluginType.Simple`, `InitializeProcessCallback`, `RenderExecutableCallback`,
    `RenderArgumentCallback` and `CheckExitCodeCallback`
  - `StdoutHandling`, `AddStdoutHandlerCallback`, `GetRegexMatch`, `SetProgress`, `SetStatusMessage` and
    `FailRender`
  - `OverrideGpuAffinity`, `GpuAffinity` and `GetThreadNumber`
  - `FileUtils.SearchFileList` and `RepositoryUtils.CheckPathMapping`
  - the `.param` and `.options` field types
- Deadline's own Python, the Monitor's plugin settings dialog, a real worker's stdout and Deadline's cancel signal
  are all unverified. A studio tester's first run will confirm them.

## OpenCue

`opencue/corridorkey_submit.py` is a PyOutline script that submits one shot as a job with two layers:

- **`render`**: books one GPU (`gpus=1`), `gpu_memory` and `memory`. By default `chunk` is the shot's length, so the
  whole shot is one task.
- **`verify`**: one task that runs after all of `render` (`depend_all`). It checks that every frame is there and is a
  whole EXR, and exits 9 if not.

```sh
python3 corridorkey_submit.py --show demo --shot sh010 \
    -i /shows/demo/sh010/plates/sh010.####.exr -o /shows/demo/sh010/key/sh010_key.####.exr \
    --range 1001-1100 --models /opt/corridorkey/models/2.0.0-onnx.4 --ort /opt/onnxruntime/lib/libonnxruntime.so \
    -- --linear --outputs alpha
```

Flags after `--` go to both commands. `--chunk N` splits the render layer; add `--preroll N` with it (same caveat
as Deadline: chunks are near-identical, and the warm-up count isn't measured yet). `--service` sets both layers'
service. Run `--help` for the rest.

**Bookings.**

- **Graphics memory, 12 GiB by default (`--gpu-memory`).** Each render task also gets `--max-vram` of the same size,
  so the engine picks a window that fits what was booked.
- **Where 12 comes from.** These are the measured peaks on an RTX 5080 with model set onnx.4, from
  [README: The same-day pair on onnx.4](../README.md#the-same-day-pair-on-onnx4-2026-10-26) and "What we got wrong" 5:

  | Run | Peak graphics memory |
  |---|---|
  | CUDA, 1280×1080 | 9.07 GiB |
  | CUDA, 4096×2160 | 9.29 GiB |
  | TensorRT, 1280×1080 | 11.04 GiB |
  | TensorRT, 4096×2160 | 10.79 GiB |
  | 3200×1800 at the 8/4 window | 11.79 GiB |

  The engine's window estimate is above every measured point. A smaller booking makes it choose a smaller, slower
  window.
- **RAM, 16 GiB by default (`--memory`).** The engine's measured RAM peaks were 13.55 GiB at 4K and 6.49 GiB at
  1280×1080 (same tables).

**Hosts.**

- Turn on GPU support in RQD on the GPU hosts. RQD then exports the booked card as `CUE_GPU_CORES`, and `corridorkey`
  reads it when no `--gpu` is given (docs/CLI.md, "The runtime").
- PyOutline sends `gpus` and `gpu_memory` only when its `spec_version` is 1.12 or later. Below that it logs a
  warning and drops them.
- Cuebot gets the commands as they are (`use_pycuerun=False`) and fills in `#FRAME_START#` and `#FRAME_END#` per
  task (`-s` / `-e`). The script quotes each argument for a POSIX shell, so Linux and macOS hosts are covered;
  Windows hosts would need their own quoting.
- `--overwrite` is always passed, so a retried task replaces the frames its earlier try renamed into place.
  `corridorkey` never exits 33 or 137 (OpenCue's retry codes).

**What's tested here, and what isn't.**

- Tested on this PC (no OpenCue here):
  - The script passes `python3 -m py_compile`.
  - A throwaway run with stand-in `outline` modules printed the two layers, their commands, the bookings and the
    dependency as intended.
- **Not yet run on a real OpenCue.**
- The script uses these names, which were checked against OpenCue's source (`pyoutline/outline/layer.py`,
  `backend/cue.py`, `modules/shell.py`, `rqd/rqcore.py`) and its PyOutline user guide:
  - `Outline`, `Shell(command=…, range=…, chunk=…)`, `gpus`, `gpu_memory`, `memory`, `set_service`, `depend_all`
  - `cuerun.launch(…, use_pycuerun=False)` and the `#FRAME_START#` / `#FRAME_END#` tokens
- Still unverified: that Cuebot accepts a `gpu_memory` like `12g`. PyOutline's own default is `1g`.

## Flamenco

`flamenco/corridorkey.js`, a Flamenco 3.x job type. Put it in the `scripts` folder next to the Manager's executable
and restart the Manager; it appears as "CorridorKey".

Settings: the command, clip, output (a folder or a `key.####.exr` pattern), outputs, scene-linear, frames (empty:
the whole shot), chunk size (0: one task over the whole range), preroll and tail (chunks only), frames already there
(`refuse`, `skip-existing`, `overwrite`), the models folder, the ONNX Runtime library, and extra flags (split as a
shell would). With chunk size 0 the job is one `key` task; otherwise Flamenco's `frameChunker` makes one task per
chunk. Each task runs the Worker's `exec` command (`exe` + `args`, Flamenco 3.3 or newer); a `verify` task depends on
all of them. Tasks have the `misc` type, which every Worker runs by default: use worker tags to keep CorridorKey on
the GPU machines. Flamenco cancels a task by killing it (Go's `exec.CommandContext`, SIGKILL): no frame reaches a
final name, but corridorkey's hidden `.corridorkey-*` folders stay behind until the next task writing to that
folder removes them (docs/CLI.md "Output safety").

**Tested here**: `node --check`, and `compileJob` run in Node against stand-ins for Flamenco's `author`,
`frameChunker` (the Manager's algorithm, internal/manager/job_compilers/js_globals.go) and `shellSplit`: the whole
shot, a range, 1001-1100 in chunks of 48 (three tasks, then `verify`), and a chunk size without frames (refused).
**Not tested**: a real Flamenco Manager and Worker (none here), the submission form in Blender's add-on.

## Shell

`shell/corridorkey-farm.sh`, for a studio without a scheduler: a list of shots, one shot per graphics card at a
time.

```sh
# shots.txt: INPUT OUTPUT [FRAMES] per line, tab-separated (spaces when no path has one); # comments
#   /plates/sh010.####.exr	/key/sh010_key.####.exr
#   /shots/sh020.mov	/key/sh020/	1001-1100
CORRIDORKEY=/opt/corridorkey/corridorkey farm/shell/corridorkey-farm.sh --gpus 0,1 --logs farm-logs shots.txt -- \
  --models /opt/corridorkey/models/2.0.0-onnx.4 --ort /opt/corridorkey/runtime/libonnxruntime.so.1.31.0 --linear
```

Each card in `--gpus` is a lane that keys its share of the list one shot after another (`--gpu N`); without
`--gpus` one lane uses the card the environment gives. Every shot runs with `--skip-existing`, so running the list
again resumes it (shots already whole end at once with exit 0); `--overwrite` keys them all again. Per shot,
`farm-logs/shot-N.log` (stdout + stderr, `--progress-format plain`) and `shot-N.report.json`; at the end a table of
every shot's exit code (docs/CLI.md "Exit codes"; `-` for a shot not run), and exit 1 if any shot didn't end 0.
Ctrl+C (in the foreground) or SIGTERM sends each running corridorkey one SIGTERM (it stops cleanly, exit 143) and no
new shot starts. Started in the background from another script, the loop ignores SIGINT (the shell's rule for
background jobs): stop it with SIGTERM.

**Tested here** (bash 5, Linux): `bash -n`; two shots of the 6-frame movie on the CPU (a pattern output keyed whole,
a folder output with `1001-1003`), both exit 0, and run again both were skipped as whole (exit 0); a SIGTERM during a
real run ended it with exit 143, no shot after it started, no corridorkey left running; with a stub command: two
lanes (`--gpus 0,1`) shared five shots, a failing shot (exit 4) made the loop exit 1. **Not tested**: real graphics
cards (none used for this), shellcheck (not installed here), macOS's bash 3.2.
