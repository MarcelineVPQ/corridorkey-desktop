# Command line

> **In the next development build, 1.0.0-dev.2.** 1.0.0-dev.1 doesn't have the command line. This page describes
> it as it will ship; until then it's in the repository's source.

`corridorkey` keys clips without the app's window: on a render farm (Deadline, AWS Deadline Cloud / Open Job
Description, OpenCue, Flamenco), from a shell loop, or from a compositor's terminal. It is the same engine as the app,
built in: a whole shot keyed here is bit for bit the app's matte. It never goes online: the models, ONNX Runtime and
ffmpeg come from paths you give it, or from the app's own install.

How to run it on a farm, per scheduler: [Render farm](Render-Farm). The app's [Console](Console) runs the same
commands inside the app.

**Contents:** [Where it is](#where-it-is) · [Commands](#commands) · [Frames](#frames) ·
[Warm-up and chunks](#warm-up-and-chunks) · [Inputs and outputs](#inputs-and-outputs) ·
[Every render option](#every-render-option) · [The runtime](#the-runtime) · [prepare and info](#prepare-and-info) ·
[Exit codes](#exit-codes) · [Progress](#progress) · [The report](#the-report) · [The version](#the-version)

## Where it is

It ships next to the engine in every package:

| System | Path |
| --- | --- |
| Linux (AppImage) | `resources/engine/corridorkey` inside the AppImage (`./CorridorKey-Desktop-<version>.AppImage --appimage-extract` unpacks it into `squashfs-root/`) |
| Windows | `resources\engine\corridorkey.exe` in the install folder (the installer's default: `%LOCALAPPDATA%\Programs\CorridorKey`) |
| macOS | `CorridorKey.app/Contents/Resources/engine/corridorkey` (no macOS build yet: [Home](Home#platforms)) |

A standalone farm archive per system is planned with the release packaging; until then, copy it from an install.

## Commands

| Command | What it does |
| --- | --- |
| `corridorkey render` | key a clip: EXR sequences (the default) or videos of `alpha`, `fg`, `cutout`, `checker` |
| `corridorkey verify` | check that every requested frame is there and reads as a whole EXR (exit 0, or 9) |
| `corridorkey prepare` | check the models, ONNX Runtime, the card, its free memory and ffmpeg before a farm's tasks start; `--tensorrt-size WxH` builds TensorRT for that size once |
| `corridorkey info` | the version, model set, ONNX Runtime, provider, card, OpenColorIO and decoders (`--json`) |
| `corridorkey run` | run a [Console](Console) script (`.ckcmd`) without the app's window: from cron, or as a farm's pre-job |
| `corridorkey help [COMMAND]` | the help; `corridorkey COMMAND -h` too, with examples |

```sh
# a plate sequence to a matte sequence, the shot's own frame numbers (EXR plates are read scene-linear)
corridorkey render -i plates/sh010.####.exr -o key/sh010_key.####.exr --outputs alpha

# afterwards (or on another machine): is every frame there and whole?
corridorkey verify -i plates/sh010.####.exr -o key/sh010_key.####.exr --outputs alpha

# a worker, before the farm's tasks start
corridorkey prepare --models /opt/ck/models/2.0.0-onnx.5 --ort /opt/ck/runtime/libonnxruntime.so.1.31.0

# what this machine has
corridorkey info --json

# a Console script from cron, the same commands and rules as in the app (--keep-going: on past a failure)
corridorkey run --keep-going ~/scripts/nightly.ckcmd
```

Options are GNU style: `--frames 1001-1100` or `--frames=1001-1100`; short ones `-F 1001-1100`. `--` ends the options
(for a clip whose name starts with `-`). A mistake is exit 2 with what to type instead (`--frame` → "a similar
argument exists: '--frames'").

`verify` takes `render`'s arguments, so the render line with `verify` in place of `render` checks its own output. It
prints each missing or cut file (`missing or incomplete: <path>`), then the frames as ranges, ready for a requeue:
`missing frames: 1012-1015, 1040 (re-render them: -F 1012-1015,1040)`.

`corridorkey run nightly.ckcmd` runs a [Console](Console#scripting) script with the app's own Console: the same
commands, checks and folders it may write in (the app's settings: the results folder, the cache, the folders you
allowed), the same audit log. It never replaces files: no one is there to confirm a `sudo` line, so a script that
needs one stops before anything runs (write into the next free version instead, `-o key/sh010_v###/`). It needs the
app installed next to it (exit 7 on a worker with only `corridorkey`), prints each command's output as it goes and
exits as the script ended. A farm's cancel (SIGTERM) and Ctrl+C stop it as Ctrl+C stops the Console (exit 130); on
Windows, Ctrl+Break ends the script at once and says so (exit 143).

For tools: `corridorkey __spec --json` prints the whole command line as JSON (every command, flag, value and
example). The app's Console reads it, and this wiki's gate checks this page against it.

## Frames

`-F` / `--frames SPEC` (Nuke's), repeatable; pieces separated by commas or spaces:

| Spec | Frames |
| --- | --- |
| `1001-1100` | 1001 to 1100 |
| `1001-1100x2`, `1001-1100:2` | every second frame: 1001, 1003, … |
| `1001,1005,1010-1020` | a list |
| `1001` | one frame |

`-s` / `--start N` and `-e` / `--end N` (Blender's) give a range; either alone runs to the shot's end or from its
start. They are what schedulers fill in: Deadline `-s <STARTFRAME> -e <ENDFRAME>`, OpenCue
`-s #FRAME_START# -e #FRAME_END#`, OpenJD `-F {{Task.Param.Frame}}`. Without any of them the whole shot is keyed.

```sh
# a movie, frames 1001-1100 of it, alpha and fg into a folder
corridorkey render shot.mov -o out/ -F 1001-1100

# every second frame
corridorkey render -i plates/sh010.####.exr -o key/sh010.####.exr --frames 1001-1100x2

# Blender's words
corridorkey render -i plates/ -o key.%04d.exr -s 1001 -e 1050
corridorkey render -i plates/ -o key.%04d.exr --start 1001 --end 1050
```

**Frame numbers are the shot's own**: a frame folder's numbers (`plate.1001.exr` is 1001), a movie's from 1001 (its
first frame is 1001), and the outputs are numbered the same way. A frame outside the shot, or one a folder skips, is
exit 2 saying the shot's range.

The networks are temporal, so a step or a list is keyed over its whole span and only the frames asked for are kept:
`-F 1001-1100x2` keys 1001-1100 and writes 50 frames, each bit for bit the frame a `-F 1001-1100` run writes.

## Warm-up and chunks

**Key one shot per task.** That is the app's matte, bit for bit. A chunk of a shot (`-F 1049-1096`) starts the
recurrent state cold at its first frame, so its first frames differ slightly from the whole shot's. `--preroll N`
keys N frames before the range and throws them away (and `--tail N` after it), so a chunk's edges have their temporal
neighbours: the chunk is then near-identical to the whole shot, not bit-identical.

```sh
corridorkey render shot.mov -o out/ -F 1049-1096 --preroll 16 --tail 8
```

**How many warm-up frames make the seams invisible hasn't been measured yet.** Until that measurement is published
(it will become the default), key the whole shot per task. The warm-up defaults to 0.

## Inputs and outputs

`-i` / `--input`, or the first argument: a movie, a frame folder, or a frame pattern `plate.####.exr`. A pattern's
folder must hold only that sequence (the engine keys a whole folder, and says so when other frames share it).

`-o` / `--output`:

- **A folder**: the same layout as the app writes, `out/<clip>_alpha_exr/<clip>_alpha.1001.exr`,
  `out/<clip>_fg_exr/…`, `out/<clip>_settings.txt` (videos: `out/<clip>_alpha.mp4`).
- **A pattern**, one file per frame, the padding from the pattern: `key.####.exr` (one digit per `#`),
  `key.%04d.exr` (printf), `key.$F4.exr` (Houdini; `$F` unpadded). With one output the files are exactly the pattern;
  with several the output's name goes before the number (`key_alpha.1001.exr`, `key_fg.1001.exr`). The settings file
  goes beside them. Patterns are for EXR; videos go in a folder.

A name without a frame number (`-o out/key.exr`) is exit 2: give a folder or a pattern. A pattern in the input
folder (`-i plates/ -o plates/key.####.exr`) is exit 2 too: put the key frames in a folder of their own.

**Your output is safe.** A run writes into a hidden folder of its own beside the output and renames the finished
frames into place only when the whole job is done, all or nothing. A failed, stopped or killed run never leaves a frame
at a final name, and two runs (or two farm machines) never share a folder. Leftover hidden folders from a killed run
(`.corridorkey-*`) are removed by the next run into the same folder, once their run is certainly over.

**Frames already there**: the run refuses (exit 4) unless you say what to do:

```sh
# replace them
corridorkey render shot.mov -o out/ --overwrite

# do nothing when every frame is there and whole; otherwise key them all again (a part can't be keyed alone)
corridorkey render shot.mov -o out/ --skip-existing
```

Temporary files (GBs on long shots) go in a folder of the run's own under `--temp DIR`, else OpenJD's session folder,
else a `--job` file's `temp_dir`, else `TMPDIR`:

```sh
corridorkey render shot.mov -o out/ --temp /scratch/ck
```

## Every render option

Each has an example; they combine freely. Values are checked as the engine checks them: a bad one is exit 2 naming
the flag (`--hint-quality must be between 0 and 1, got 2`).

**What to write**

```sh
# outputs: alpha, fg, cutout, checker, comma-separated (default alpha,fg)
corridorkey render shot.mov -o out/ --outputs alpha,fg,cutout,checker

# videos instead of EXR sequences (whole shots only)
corridorkey render shot.mov -o out/ --format video --codec dnxhr444

# EXR pixel type: half (default) or float
corridorkey render shot.mov -o out/ --datatype float

# video outputs: H.264 with your own CRF, x264 preset and pixel format
corridorkey render shot.mov -o out/ --format video --codec h264-crf12 --crf 10 --preset slow --pix-fmt yuv444p10le

# a frame folder's rate for video outputs (default 24), and a cutout video in linear light
corridorkey render -i plates/ -o out/ --format video --outputs cutout --fps 25 --cutout-linear
```

Codecs: `h264-crf12` (the default), `h264-lossless`, `dnxhr444`.

**Hints**

```sh
# a first-frame matte (a PNG's alpha, an EXR's A), and how much to trust it (0-1, default 0.95)
corridorkey render shot.mov -o out/ --hint first_matte.png --hint-quality 0.9

# a hint matte for every frame (a video or a frame folder)
corridorkey render shot.mov -o out/ --hint-video roto.mov

# don't carry each window's matte into the next, or trust the carried one less
corridorkey render shot.mov -o out/ --no-carry-hint
corridorkey render shot.mov -o out/ --carry-hint-quality 0.8
```

A first-frame matte belongs to the shot's first frame: not with a chunk that starts later.

**The image going in**

```sh
# a frame folder is read as the app starts one: scene-linear when its first frame is EXR, display-coded otherwise
# (PNG, JPEG). Choose it yourself: --linear reads it scene-linear, --no-linear display-coded (clipped to 0-1)
corridorkey render -i plates/sh010.####.exr -o key/ --no-linear
corridorkey render -i pngs/sh010.####.png -o key/ --linear

# keep a 10- or 12-bit source's bits (8 reads it as CorridorKey 2.0 does)
corridorkey render shot.mov -o out/ --input-bit-depth 16

# linear adjust before keying (video inputs): gain, contrast and its pivot
corridorkey render shot.mov -o out/ --brightness 1.2 --contrast 1.1 --contrast-pivot 0.18

# despill strength (0-1, default 0.5)
corridorkey render shot.mov -o out/ --despill 0.7

# colour management (EXR and image sequences): a config (a path or an ocio:// name; default $OCIO, else the ACES
# studio config) and the plates' and outputs' colour spaces
corridorkey render -i plates/ -o key/ --ocio ocio://studio-config-latest --input-colorspace "ACEScg" --output-colorspace "ACEScg"
```

**Speed and memory**

```sh
# the networks at half the plate's size (above 0, up to 2)
corridorkey render shot.mov -o out/ --model-scale 0.5

# a manual Hann window: 24 frames, stride 12 (default: automatic, from the free graphics memory)
corridorkey render shot.mov -o out/ --window 24/12

# less graphics memory: one phase's networks at a time, and a cap on what the job may use
corridorkey render shot.mov -o out/ --low-vram --max-vram 10

# TensorRT (build its range first with prepare --tensorrt-size), and never build inside the job
corridorkey render shot.mov -o out/ --tensorrt --no-tensorrt-build
```

`--no-tensorrt-build` makes a size range that isn't built yet run on CUDA instead of building it inside the task.

**A job file, logging, the report**

```sh
# the engine protocol's run object (input, output_dir, temp_dir, options); flags win over it
corridorkey render --job sh010.json --report sh010.report.json -q

# every engine reply on stderr too
corridorkey render shot.mov -o out/ -v
corridorkey render shot.mov -o out/ --verbose --progress-format plain

# failures only on stderr
corridorkey render shot.mov -o out/ --quiet
```

A `--job` file that sets `num_frames`, `start_mode` or `seed` (the app's preview sample) is refused (exit 2): on the
command line `--frames` picks the frames.

## The runtime

| Flag | Environment | Meaning |
| --- | --- | --- |
| `--models DIR` | `CK_ENGINE_MODELS` | the ONNX model set's folder |
| `--ort LIB` | `CK_ENGINE_ORT`, `ORT_DYLIB_PATH` | ONNX Runtime's library |
| `--device auto\|cuda\|cpu\|coreml\|migraphx` | `CK_ENGINE_DEVICE` | the graphics card (default); the CPU (slow; tests); Core ML (macOS); MIGraphX (an AMD card, Linux; untested on a real AMD card) |
| `--gpu N\|UUID` | `CUDA_VISIBLE_DEVICES`, `CUE_GPU_CORES` | the card: an index in CUDA's order or a `GPU-…` / `MIG-…` UUID (Nuke's `--gpu`) |
| `-t`, `--threads N` | `CK_ENGINE_THREADS` | CPU threads per network (0: ONNX Runtime's choice) |

```sh
corridorkey render shot.mov -o out/ --models /opt/ck/models/2.0.0-onnx.5 --ort /opt/ck/runtime/libonnxruntime.so.1.31.0 --gpu 1
corridorkey render shot.mov -o out/ --gpu GPU-5f1c2a3b-0000-0000-0000-000000000000
corridorkey render shot.mov -o out/ --device cpu --threads 8
corridorkey render shot.mov -o out/ --device cpu -t 0
```

Without `--gpu`, a `CUDA_VISIBLE_DEVICES` already set is the farm's choice; without both, OpenCue's booking
(`CUE_GPU_CORES`) gives its first card.

**The app's own install.** Without `--models` (and `CK_ENGINE_MODELS`) or `--ort` (and its variables), `render`,
`prepare` and `info` use what the app installed: the newest model set and the newest ONNX Runtime in the app's data
folder (`~/.local/share/corridorkey-desktop` on Linux, `%LOCALAPPDATA%\corridorkey-desktop` on Windows,
`~/Library/Application Support/corridorkey-desktop` on macOS). It says what it found on stderr (not with `-q`). So
the Queue's **Copy as command** line runs pasted into a terminal as it is. A flag or variable you give always wins;
with no app install it says what's missing (exit 7). (This fallback on a real graphics card isn't tested yet; the
tests use a fake install.)

## prepare and info

```sh
# check a worker: models, runtime, card, free memory, ffmpeg; a JSON report for the farm
corridorkey prepare --gpu 0 --report prepare.json --progress-format plain

# build TensorRT once for 4K clips at the window a 12 GB job gets, so no task waits on it (minutes)
corridorkey prepare --gpu 0 --tensorrt-size 4096x2160 --max-vram 12

# what this machine has, for people or for tools
corridorkey info
corridorkey info --json --device cpu
```

`prepare` exits 0 and prints `ready` when the worker can key; otherwise the exit code says what's missing.

## Exit codes

Farms treat any non-zero exit as a failure and retry; the code says whether a retry can help. Never 1 for anything
specific, never 33 or 137 (OpenCue's retry codes).

| Code | Meaning | Retry? |
| --- | --- | --- |
| 0 | done (or `--skip-existing` found every frame whole; `verify`: every frame whole) | |
| 2 | usage: a bad flag, value, frame list or job file; the engine refused the request | no: fix the command |
| 3 | input: the clip, a hint or a frame can't be read, or isn't there | no |
| 4 | output: the folder isn't writable, the disk is full, or frames are already there (no `--overwrite`) | after a fix |
| 5 | no usable graphics card (or Core ML provider) | on another machine |
| 6 | out of graphics memory | with `--max-vram` lower, `--low-vram`, a smaller `--window`, or a bigger card |
| 7 | the models, ONNX Runtime, ffmpeg or a library are missing | after `corridorkey prepare` passes |
| 8 | the engine failed (a bug: the message and the report say what; please report it) | maybe |
| 9 | `verify`: a requested frame is missing or not a whole EXR | re-render |
| 130 | stopped by SIGINT (Ctrl+C), cleanly | |
| 143 | stopped by SIGTERM (the farm's cancel), cleanly | |

The messages behind each are on [Troubleshooting](Troubleshooting).

**Stopping.** SIGTERM and SIGINT stop the run after the frame (or window) it is on: no frame goes to a final name,
the run's folders are removed, then exit 143 / 130. A second signal ends it at once. On Windows, Ctrl+C is SIGINT;
Ctrl+Break, closing the console, log-off and shut-down are SIGTERM (Windows gives a closing console 5 seconds). A
farm's SIGKILL after its grace time leaves the output safe; only the hidden folders stay until the next run.

`corridorkey` keeps running when the program that started it exits (containers, farm launchers).

## Progress

On stdout, one line at a time. `--progress-format`:

| Format | Progress | Phase | Before a non-zero exit |
| --- | --- | --- | --- |
| (default) | `openjd_progress: 45` and `PROGRESS: 45%` | `openjd_status: keying: window 3/10 done` | `openjd_fail: <message> (exit 6, out-of-graphics-memory)` |
| `openjd` (OpenJD, AWS Deadline Cloud) | `openjd_progress: 45` | `openjd_status: …` | `openjd_fail: …` |
| `deadline` (Deadline 10's plugin) | `PROGRESS: 45%` | `STATUS: …` | `ERROR: …` |
| `plain` | `45% (45/100 frames)` | the phase | `failed: …` |
| `json` | `{"event":"progress","percent":45,"done":45,"total":100}` | `{"event":"status","text":"…"}` | `{"event":"fail","exit_code":6,"reason":"out-of-graphics-memory","message":"…"}` |

```sh
corridorkey render -i plates/ -o key.%04d.exr -s 1001 -e 1050 --progress-format openjd
corridorkey render -i plates/ -o key.%04d.exr -s 1001 -e 1050 --progress-format deadline
corridorkey render shot.mov -o out/ --progress-format json
```

The percentage is the engine's own count of frames handed to the writers: never an estimate. A long shot sits at 0 %
through the first passes; the phase lines say where it is (`loading the models`, `reading the clip`,
`building TensorRT`, `RVM pass (warm-up frames included)`, `foundation pass`, `keying: window i/n done`). The human log
goes to stderr.

## The report

`--report FILE.json` writes the run as JSON however it ends. Schema `corridorkey-report/1`:

| Key | Value |
| --- | --- |
| `schema` | `"corridorkey-report/1"` |
| `corridorkey` | the version (as `--version` prints it) |
| `command` | `render`, `verify` or `prepare` |
| `exit_code`, `exit_reason` | the exit code and its name: `done`, `usage`, `input`, `output`, `no-gpu`, `out-of-graphics-memory`, `assets`, `engine`, `incomplete`, `interrupted`, `terminated` |
| `message` | why it failed (null when it didn't) |
| `input`, `output` | as given |
| `models` | `{"dir", "set"}`: the folder and its version (`2.0.0-onnx.5`) |
| `onnxruntime` | ONNX Runtime's version |
| `provider`, `precision`, `provider_fallback` | what ran the job (`cuda`, `tensorrt`, `tensorrt+cuda`, `cpu`, `coreml`; `fp16` / `fp32`) and why TensorRT wasn't used, if asked for |
| `gpu` | `{"name", "driver", "vram_total_mb"}` or null |
| `window` | `{"chunk", "stride", "low_vram", "auto"}`: the window used |
| `frames.requested` | the frames asked for, or null (the whole shot) |
| `frames.keyed` | `{"first", "last"}`: the span keyed, warm-up and tail included |
| `frames.written` | `{"first", "last", "count"}`: the frames put at their final names |
| `frame_times` | `[{"frame", "done_s"}]`: seconds from the start at which each written frame was handed to the writers |
| `seconds` | the run's wall time |
| `skipped` | `--skip-existing` found every frame whole |
| `missing` | `verify`: the files missing or not whole |

```sh
corridorkey verify -i plates/sh010.####.exr -o key/sh010_key.####.exr --report sh010.verify.json
```

## The version

`corridorkey --version` (and any command's `-V`, as `corridorkey render --version`) prints the app release it ships
in, such as `1.0.0-dev.2`; `info`, the report and the app's engine say the same.
