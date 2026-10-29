# `corridorkey`: the command line

Its page for users is the wiki's Command line (`docs/wiki/Command-Line.md`; `tools/check_wiki.mjs` fails when a
command, flag, exit code or progress format is missing there: change both together).

`corridorkey` keys clips without the app: on a render farm (Deadline, AWS Deadline Cloud / Open Job Description,
OpenCue, Flamenco), from a shell loop, or from a compositor's terminal. It is the same engine as the app (ck-core,
linked in; [ENGINE_RUST.md](ENGINE_RUST.md)): a whole shot keyed here is bit for bit the app's matte (tested:
`engine-rs/crates/ck-cli/tests/e2e.rs`). It never touches the network: models, ONNX Runtime and ffmpeg come from paths
you give it.

It ships next to the engine: `resources/engine/corridorkey` in the AppImage and the macOS app,
`resources\engine\corridorkey.exe` in the Windows install. (A standalone farm archive per system comes with the
release packaging.)

```sh
# a plate sequence to a matte sequence, the shot's own frame numbers (Nuke: -F, -o)
# (EXR plates are read scene-linear by default, as the app starts them: --no-linear reads them display-coded)
corridorkey render -i plates/sh010.####.exr -o key/sh010_key.####.exr --outputs alpha

# a movie, frames 1001-1100 of it (a movie's frames count from 1001), alpha and fg into a folder
corridorkey render shot.mov -o out/ -F 1001-1100

# Blender's words: start and end (what Deadline's <STARTFRAME> / <ENDFRAME> fill in)
corridorkey render -i plates/ -o key.%04d.exr -s 1001 -e 1050 --gpu 1

# a farm task: OpenJD progress lines, a JSON report, quiet stderr
corridorkey render --job sh010.json --progress-format openjd --report sh010.report.json -q

# afterwards (or on another machine): is every frame there and whole?
corridorkey verify -i plates/sh010.####.exr -o key/sh010_key.####.exr --outputs alpha
```

## Commands

| command | does |
|---|---|
| `corridorkey render` | key a clip: EXR sequences (the default) or videos of `alpha`, `fg`, `cutout`, `checker` |
| `corridorkey verify` | check that every requested frame is there and reads as a whole EXR (exit 0, or 9) |
| `corridorkey prepare` | check the models, ONNX Runtime, the card, its free memory, ffmpeg and ffprobe before a farm's tasks start; `--tensorrt-size WxH` builds TensorRT's engines for that size (a one-time build of minutes, so no task waits on it) |
| `corridorkey info` | version, model set, ONNX Runtime, provider, card, OpenColorIO, decoders (`--json`) |
| `corridorkey run [--keep-going] FILE.ckcmd` | a Console script without the app's window (cron, a farm's pre-job): ck-cli's `headless.rs` starts the app's own executable with its `--ck-headless` flag (`electron/main/boot.ts`, `headlessFlag.ts`: no window, no graphics card, one fixed script runner; never as Node: the `runAsNode` fuse is off), passing itself as `CK_HEADLESS_CLI`, which a packaged app accepts only when it is its own `resources/engine/corridorkey`; on macOS a start whose parent is launchd (pid 1: `open -a`, LaunchServices, a LaunchAgent starting the CLI directly) is refused, exit 2, so a script's reads are never CorridorKey's own (its privacy grants) on someone else's behalf: a LaunchAgent runs `/bin/sh -c 'corridorkey run FILE; exit $?'` (`CK_APP` names a development build's Electron, `CK_APP_ENTRY` its app folder); the app's Console runner runs it with the app's settings (write folders, bookmarks, kept variables), its audit log and a history of its own (`console-history-headless.jsonl`); anything that needs a confirmation (`sudo` lines, `allow`) is refused in words; exit 7 when the app isn't next to it, else the script's status (backlog row 151). On Linux and macOS it execs the app (the same process: a farm's SIGTERM reaches the runner, and a death by signal shows as that signal); on Windows it waits and takes Ctrl+C / Ctrl+Break itself (the app's own SIGINT handling isn't relied on there): the runner starts in a process group of its own and stops when the CLI writes `stop` on its stdin (`CK_HEADLESS_STOP=stdin`: its own cancel, exit 130); when Ctrl+Break, which reaches every process on the console, ends the runner first, the CLI says the script stopped and exits 143; a second Ctrl+C ends both |
| `corridorkey help [COMMAND]` | the help; `corridorkey COMMAND -h` too, with examples. `corridorkey --version` (and `corridorkey render --version`, any command's `-V`): the app release it ships in (package.json's version, e.g. `1.0.0-dev.1`; the engine's pong says the same) |

Options are GNU style: `--frames 1001-1100` or `--frames=1001-1100`, short ones `-F 1001-1100`; `--` ends the options
(for a clip whose name starts with `-`). A mistake is exit 2 with what to type instead (`--frame` → "a similar
argument exists: '--frames'").

`verify` takes `render`'s arguments, so the render line with `verify` in place of `render` checks its own output. It prints
each missing or cut file (`missing or incomplete: <path>`), then the frames as ranges, ready for a requeue:
`missing frames: 1012-1015, 1040 (re-render them: -F 1012-1015,1040)`; its failure message names them too.

For tools: `corridorkey __spec --json` (hidden from the help) prints the command line itself as JSON: `version`,
`about`, and `commands` (`name`, `about`, `examples`, `args`: `id`, `long`, `short`, `positional`, `value_name`,
`possible_values`, `help`, `required`, `multiple`, `default`, `takes_value`, `hidden`, `conflicts_with`: the ids it
can't be used with, as declared on it, so check both directions). It walks the same parser the
commands use, so it can't drift from them; the app's Console reads it for completion and hints.

## Frames

`-F` / `--frames SPEC` (Nuke's), repeatable; pieces separated by commas or spaces:

| spec | frames |
|---|---|
| `1001-1100` | 1001 to 1100 |
| `1001-1100x2`, `1001-1100:2` | every second frame: 1001, 1003, … |
| `1001,1005,1010-1020` | a list |
| `1001` | one frame |

`-s` / `--start N` and `-e` / `--end N` (Blender's) give a range; either alone runs to the shot's end or from its
start. They are what schedulers fill in: Deadline `-s <STARTFRAME> -e <ENDFRAME>`, OpenCue `-s #FRAME_START#
-e #FRAME_END#`, OpenJD `-F {{Task.Param.Frame}}`. Without any of them the whole shot is keyed.

Frame numbers are the shot's own: a frame folder's numbers (`plate.1001.exr` is 1001), a movie's from 1001 (its
first frame is 1001), as the outputs are numbered. A frame outside the shot (an `-s` / `-e` end or a job file's
`frame_start` / `frame_end` too), or one a folder skips, is exit 2 saying the shot's range; `-s` / `-e` keep only a
folder's gaps inside the range out of the frames, never an end past the shot.

The networks are temporal (RVM runs through every frame; the windows blend neighbours), so a step or a list is keyed
over its whole span and only the frames asked for are kept: `-F 1001-1100x2` keys 1001-1100 (to the end of the range,
even though 1100 isn't written) and writes 50 frames, each bit for bit the frame a `-F 1001-1100` run writes. A list
keys from its first frame to the end of its last piece (`1001,1050`: 1001-1050).

### Warm-up (`--preroll`, `--tail`) and chunks

**Key one shot per task.** That is the app's matte, bit for bit. A chunk of a shot (`-F 1049-1096`) starts the
recurrent state cold at its first frame, so its first frames differ slightly from the whole shot's. `--preroll N` keys
N frames before the range and throws them away (and `--tail N` after it) so the chunk's edges have their temporal
neighbours; a chunk is then near-identical to the whole shot, not bit-identical. How many warm-up frames make the
seams invisible is measured in the farm plan's phase 3 (it becomes the default then); **until it is published, key
the whole shot.**

## Paths

`-i` / `--input`, or the first argument: a movie, a frame folder, or a frame pattern `plate.####.exr` (its folder,
which must hold only that sequence: the engine keys a whole folder, and says so when other frames share it). An EXR
frame whose data window isn't its display window (overscan, autocropped) is refused, exit 3, until backlog rows 30 h
and 34 carry both windows through.

`-o` / `--output`:

- **a folder**: the engine's own layout inside it, as the app writes it:
  `out/<clip>_alpha_exr/<clip>_alpha.1001.exr`, `out/<clip>_fg_exr/…`, `out/<clip>_settings.txt` (videos:
  `out/<clip>_alpha.mp4`).
- **a pattern**, one file per frame, the padding from the pattern: `key.####.exr` (4 digits; one per `#`),
  `key.%04d.exr` (printf), `key.$F4.exr` (Houdini; `$F` unpadded). One output writes exactly the pattern; several
  add the output's name before the number: `key_alpha.1001.exr`, `key_fg.1001.exr`. The settings file goes beside them
  (`key_settings.txt`). Patterns are for EXR; videos go in a folder.

A name without a frame number (`-o out/key.exr`) is exit 2: give a folder or a pattern. So is a pattern in the
input folder (`-i plates/ -o plates/key.####.exr`): it would work once, then every later task (a chunk, a retry)
would find the key frames beside the plates.

### Output safety

- The job writes into a hidden folder of its own beside the output (`.corridorkey-<host>-<pid>-<random>`, same
  drive; the machine's name and 64 random bits, so the machines and containers of a farm writing to one share never
  pick the same name, and the folder is made only if no folder has that name). Only when the whole job is done are
  the requested frames renamed to their final names. A failed, stopped or killed run never leaves a frame at a final
  name, and two runs never share a folder.
- Those renames are all or nothing. Frames already at the names (`--overwrite`) are first moved aside into the
  hidden folder, then the new ones put in place; a rename is tried four times over 0.65 s (a reader holding a frame
  on Windows, a share's hiccup). If one still fails, every rename done is undone (the old frames back at their names,
  the new ones back in the hidden folder, then removed) and the run exits 4 saying which file: the output is as it
  was before the run. Only if the undo fails as well is the hidden folder kept, and the message names it (the new
  frames, and the old ones in its `.replaced`). A SIGKILL in the milliseconds of the renames can leave old frames in
  `.replaced` too.
- Each EXR frame is written to a hidden `.<name>.partial`, flushed to disk (fsync) and renamed into place (ck-core,
  the app's jobs too): a writer killed mid-frame, or a power loss, never leaves a cut or empty EXR at the frame's name.
  `CK_ENGINE_EXR_FSYNC=0` skips the fsync: unmeasured on SMB/NFS; turn off only if per-frame writes are slow there.
- Temporary files (the RVM features and states, GBs on long shots) go in a folder of the run's own under `--temp DIR`,
  else `OPENJD_SESSION_WORKING_DIR` (OpenJD's session folder), else the job file's `temp_dir`, else `TMPDIR`.
- Both folders are removed when the run ends, however it ends. A SIGKILL leaves them (hidden `.corridorkey-*` and
  `corridorkey-*` folders, safe to delete), and the next `render` with the same output folder (or temporary folder)
  removes them, saying so on stderr, when their run is certainly over. Each run holds a lock on a `.corridorkey.lock`
  file in both folders while it lives (the system drops it when the process ends, killed or not); a folder whose lock
  is held is never touched. Otherwise a folder goes when it was made on this machine (by name) by a process that no
  longer runs, or when nothing in it changed for 7 days (another machine's, or an older version's
  `.corridorkey-<pid>-<time>`). On a filesystem without file locks the process and age rules alone decide.
- Frames already at the output's names: the run refuses (exit 4) unless told. `--overwrite` replaces them;
  `--skip-existing` does nothing (exit 0) when **every** requested frame is there and reads as a whole EXR, and keys
  them all again otherwise (a part can't be keyed alone without changing the matte). Reruns give the same result.

## Options

### render (and verify)

| flag | run option ([ENGINE_PROTOCOL.md](ENGINE_PROTOCOL.md)) | meaning |
|---|---|---|
| `-i`, `--input INPUT` (or the first argument) | `input` | the clip |
| `-o`, `--output DIR\|PATTERN` | `output_dir` | where the results go (above) |
| `-F`, `--frames SPEC`; `-s`, `--start N`; `-e`, `--end N` | `frame_start`, `frame_end` | the frames to write (above) |
| `--preroll N`, `--tail N` | `preroll`, `tail` | warm-up frames keyed and never written (above; at most 100000 each) |
| `--outputs LIST` | `outputs` | `alpha`, `fg`, `cutout`, `checker`, comma-separated (`alpha,fg`) |
| `--format exr\|video` | `output_format` | EXR sequences (**the default here**; the app's is video) or videos (whole shots only) |
| `--datatype half\|float` | `exr_dtype` | EXR pixel type (half) |
| `--window C/S` | `hann_chunk`, `hann_stride` | a manual Hann window, C frames, stride S (`C` alone: S = C/2); default automatic from free memory |
| `--low-vram` | `low_vram` | one phase's networks at a time |
| `--max-vram GB` | `vram_budget_gb` | graphics memory this job may use |
| `--tensorrt` | `tensorrt` | TensorRT (build the range first with `prepare --tensorrt-size`) |
| `--no-tensorrt-build` | `tensorrt_build: false` | never build TensorRT inside the job; a range not built yet runs on CUDA |
| `--hint FILE` | `hint_first_frame` | first-frame matte (the shot's first frame only: not with a chunk that starts later) |
| `--hint-video PATH` | `hint_video` | a hint matte per frame |
| `--hint-quality Q` | `hint_quality` | trust in the hint, 0-1 (0.95) |
| `--no-carry-hint` | `carry_hint: false` | don't carry each window's matte into the next |
| `--carry-hint-quality Q` | `carry_hint_quality` | 0-1 (0.95) |
| `--despill S` | `despill_strength` | 0-1 (0.5) |
| `--cutout-linear` | `cutout_linear` | a video cutout in linear light |
| `--linear` | `frame_dir_linear` | read a frame folder scene-linear |
| `--no-linear` | `frame_dir_linear: false` | read a frame folder display-coded, clipped to 0-1 (not with `--linear`) |
| `--fps FPS` | `frame_dir_fps` | a frame folder's rate for video outputs (24; above 0, at most 1000) |
| `--model-scale S` | `model_scale` | the networks at S times the plate's size (above 0, up to 2) |
| `--brightness G`, `--contrast C`, `--contrast-pivot P` | `linear_brightness`, `linear_contrast`, `linear_contrast_pivot` | linear adjust before keying (video inputs) |
| `--input-bit-depth 8\|16` | `input_bit_depth` | 8 reads as CorridorKey 2.0 does; 16 keeps a deep source's bits |
| `--ocio CONFIG` | `color_config` | OpenColorIO config: a path or `ocio://` name (`$OCIO`, else the ACES studio config) |
| `--input-colorspace NAME`, `--output-colorspace NAME` | `input_colorspace`, `output_colorspace` | colour management (EXR and image sequences) |
| `--codec NAME`, `--crf N`, `--preset NAME`, `--pix-fmt FMT` | `video_codec`, `crf`, `preset`, `pix_fmt` | video outputs |
| `--job FILE.json` | the whole `run` object | the protocol's run object (`input`, `output_dir`, `temp_dir`, `options`); flags win over it |
| `--temp DIR` | `temp_dir` (a folder of the run's own inside it) | temporary files |
| `--overwrite`, `--skip-existing` | | frames already there (above) |
| `--report FILE.json` | | the run as JSON (below) |
| `--progress-format F` | | `openjd`, `deadline`, `plain`, `json` (below) |
| `-v`, `--verbose`; `-q`, `--quiet` | | stderr: also every engine reply; or failures only |

A frame folder (or pattern) without `--linear` / `--no-linear` is read as the app starts one: scene-linear when its
first frame (in the engine's order) is OpenEXR, display-coded otherwise (PNG, JPEG). A `--job` file's
`frame_dir_linear` (`true` / `false`; `null` as absent) is used when neither flag is given. A movie ignores all three.
The run says which it used and why on stderr and in the report (`frame_dir_linear`); the engine's warning about EXR
read display-coded comes only after `--no-linear` (or a job file's `false`).

Run options without a flag, and why: `num_frames`, `start_mode`, `seed` pick a preview sample of a movie in the app;
on the command line `--frames` picks the frames, and a `--job` file that sets them is refused (exit 2, saying so).
Values are checked as the engine checks the protocol's options; a bad one is exit 2 naming the flag
(`--hint-quality must be between 0 and 1, got 2`).

### The runtime (render, prepare, info)

| flag | environment | meaning |
|---|---|---|
| `--models DIR` | `CK_ENGINE_MODELS` | the ONNX model set's folder (the app's: `~/.local/share/corridorkey-desktop/models/<set>`) |
| `--ort LIB` | `CK_ENGINE_ORT`, `ORT_DYLIB_PATH` | ONNX Runtime's library (the app's GPU runtime download) |
| `--device auto\|cuda\|cpu\|coreml\|migraphx` | `CK_ENGINE_DEVICE` | the card (default; Core ML on a Mac, from dev.3); the CPU provider (slow; tests); Core ML (macOS); MIGraphX (an AMD card, Linux; untested on a real AMD card) |
| `--gpu N\|UUID` | `CUDA_VISIBLE_DEVICES`, `CUE_GPU_CORES` | the card, an index in CUDA's order or a `GPU-…` / `MIG-…` UUID (Nuke's `--gpu`). It sets `CUDA_VISIBLE_DEVICES` before the runtime starts. Without it a `CUDA_VISIBLE_DEVICES` already set is the farm's choice; without both, OpenCue's booking (`CUE_GPU_CORES`) gives its first card |
| `-t`, `--threads N` | `CK_ENGINE_THREADS` | CPU threads per network (0: ONNX Runtime's choice) |

**The app's own install.** Without `--models` and `CK_ENGINE_MODELS` (or `--ort`, `CK_ENGINE_ORT` and
`ORT_DYLIB_PATH`), `render`, `prepare` and `info` use what the app installed, by the Engine page's "Automatic" rule:
the newest model set in `<data>/models/` (one with `models.json`, newest by its manifest's `created`) and the newest
ONNX Runtime in `<data>/runtime/<name>/onnxruntime/capi/` (by version). `<data>` is the app's data folder:
`$XDG_DATA_HOME/corridorkey-desktop` (else `~/.local/share/corridorkey-desktop`) on Linux,
`%LOCALAPPDATA%\corridorkey-desktop` on Windows, `~/Library/Application Support/corridorkey-desktop` on macOS. It says
what it found on stderr (`corridorkey: no --models given: using the app's model set …`; not with `-q`), so the
Queue's **Copy as command** line runs pasted into a terminal as it is. The runtime's CUDA and TensorRT library folders
come with it, as the app adds them: on Linux the CLI starts itself again once with them on `LD_LIBRARY_PATH` (read
only when a program starts); on Windows they go on `PATH`. A flag or variable you give always wins; with no app
install it says what is missing, as before (exit 7). Code: `crates/ck-cli/src/appinstall.rs` (P4 SME review
2026-10-27 S2).

Every other engine knob is its `CK_ENGINE_*` variable ([ENGINE_RUST.md](ENGINE_RUST.md) "Knobs"), as for the engine.
`prepare` also takes `--tensorrt-size WxH` and `--max-vram GB`; `info` takes `--json`.

## Exit codes

Farms treat any non-zero exit as a failure and retry; the code says whether a retry can help. Never 1 for anything
specific, never 33 or 137 (OpenCue's retry codes). `corridorkey run` is the exception: its status is the script's
(the Console's `${status}`: a line's own exit code, else 2 refused, 130 stopped, 1 failed), not this table's.

| code | meaning | retry? |
|---|---|---|
| 0 | done (or `--skip-existing` found every frame whole; `verify`: every frame whole) | |
| 2 | usage: a bad flag, value, frame list or job file; the engine refused the request | no: fix the command |
| 3 | input: the clip, a hint or a frame can't be read, or isn't there | no |
| 4 | output: the folder isn't writable, the disk is full, or frames are already there (no `--overwrite`) | after a fix |
| 5 | no usable graphics card (or Core ML provider) | on another machine |
| 6 | out of graphics memory | with `--max-vram` lower, `--low-vram`, a smaller `--window`, or a bigger card |
| 7 | the models, ONNX Runtime, ffmpeg or a library are missing | after `corridorkey prepare` passes |
| 8 | the engine failed (a bug: the message and report say what) | maybe |
| 9 | `verify`: a requested frame is missing or not a whole EXR | re-render |
| 130 | stopped by SIGINT (Ctrl+C), cleanly | |
| 143 | stopped by SIGTERM (the farm's cancel), cleanly | |

**Signals.** SIGTERM and SIGINT stop the run after the frame (or window) it is on: no frame goes to a final name, the
run's folders are removed, then exit 143 / 130. A TensorRT build (`prepare --tensorrt-size`, or a job's own) stops
before the next network's build (one takes minutes; the engines already built are kept), and `prepare` then exits
143 / 130 without printing `ready`. A second signal ends it at once. On Windows Ctrl+C is SIGINT and
Ctrl+Break, closing the console, log-off and shut-down are SIGTERM. Windows ends a process 5 s after a console close
(Microsoft's HandlerRoutine docs), so for those three the run has 4.5 s to stop and clean up; a stop that takes
longer (a long window on a slow card) ends like a SIGKILL: the output stays safe, the hidden folders are left for the
next run's sweep. Farms send SIGKILL after their grace time: the
output stays safe (above), only the hidden folders are left.

**No parent watch.** Unlike `corridorkey-engine` (which ends with the app), `corridorkey` keeps running when its parent
exits or is PID 1 (containers, farm launchers). This holds by construction: only `corridorkey-engine` calls
`ck_core::proc::end_with_parent`; `corridorkey` has no code that watches its parent. The test
`tests/cli.rs` `a_launcher_that_exits_first_doesnt_end_the_task` only shows an orphaned `verify` runs to its end (it
finishes before any watch could fire, so it can't prove more; farm senior review 2026-10-26 N5).

## Progress

On stdout, one line at a time, flushed. `--progress-format`:

| format | progress | phase | before a non-zero exit |
|---|---|---|---|
| (default) | `openjd_progress: 45` and `PROGRESS: 45%` | `openjd_status: keying: window 3/10 done` | `openjd_fail: <message> (exit 6, out-of-graphics-memory)` |
| `openjd` (OpenJD, AWS Deadline Cloud) | `openjd_progress: 45` | `openjd_status: …` | `openjd_fail: …` |
| `deadline` (Deadline 10 plugin handlers) | `PROGRESS: 45%` | `STATUS: …` | `ERROR: …` |
| `plain` | `45% (45/100 frames)` | the phase | `failed: …` |
| `json` | `{"event":"progress","percent":45,"done":45,"total":100}` | `{"event":"status","text":"…"}` | `{"event":"fail","exit_code":6,"reason":"out-of-graphics-memory","message":"…"}` |

The percentage is the engine's own count of frames handed to the writers (its `frames` replies), one line per change
of a whole percent: no estimate. A long shot sits at 0 % through the RVM pass and the first windows; the phase lines
say where it is (`loading the models`, `reading the clip`, `building TensorRT`, `RVM pass (warm-up frames included)`,
`foundation pass`, `keying: window i/n done`). The human log (what the app's log shows) goes to stderr.

## Report

`--report FILE.json` writes the run as JSON however it ends (written to a temporary name and renamed). Schema
`corridorkey-report/1`:

| key | value |
|---|---|
| `schema` | `"corridorkey-report/1"` |
| `corridorkey` | the version: the app release (`1.0.0-dev.1`), as `--version` prints it |
| `command` | `render`, `verify` or `prepare` |
| `exit_code`, `exit_reason` | the exit code and its name: `done`, `usage`, `input`, `output`, `no-gpu`, `out-of-graphics-memory`, `assets`, `engine`, `incomplete`, `interrupted`, `terminated` |
| `message` | why it failed (null when it didn't) |
| `input`, `output` | as given |
| `frame_dir_linear` | a frame folder: `{"value", "why"}`, read scene-linear or not and why: `--linear`, `--no-linear`, `--job`, `default: EXR plates` or `default: not EXR`; null for a movie |
| `models` | `{"dir", "set"}`: the folder and its manifest's version (`2.0.0-onnx.5`) |
| `onnxruntime` | ONNX Runtime's version |
| `provider`, `precision`, `provider_fallback` | what ran the job (`cuda`, `tensorrt`, `tensorrt+cuda`, `cpu`, `coreml`; `fp16` / `fp32`) and why TensorRT wasn't used, if asked for |
| `gpu` | `{"name", "driver", "vram_total_mb"}` or null |
| `window` | `{"chunk", "stride", "low_vram", "auto"}`: the Hann window used (after any out-of-memory retry) |
| `frames.requested` | the frames asked for, or null (the whole shot) |
| `frames.keyed` | `{"first", "last"}`: the span keyed, warm-up and tail included |
| `frames.written` | `{"first", "last", "count"}`: the frames put at their final names |
| `frame_times` | `[{"frame", "done_s"}]`: seconds from the start at which each written frame was handed to the writers (the engine reports at most four times a second; frames reported together share a time) |
| `seconds` | the run's wall time |
| `skipped` | `--skip-existing` found every frame whole |
| `missing` | `verify`: the files missing or not whole |

## Adding an option

A new job setting reaches the command line in four places, and `npm run gates` fails until each is there
(`tools/check_cli_parity.mjs`, its own gate; the wiki has another, `tools/check_wiki.mjs`):

1. **The engine** reads it from the run request (ck-core `job.rs` `parse`; docs/ENGINE_PROTOCOL.md).
2. **The CLI** gives it a flag (ck-cli `args.rs` `RUN_OPTIONS`), then `node tools/gen_cli_spec.mjs` refreshes
   `src/shared/console/cliSpec.json`.
3. **The manifest**, `docs/cli-parity.json`: the field with its flags, or `"not-on-cli"` and why; a new flag that sets
   no field goes under `"cli-only"` with what it is for.
4. **Copy as command** writes it (`jobFlags` in `src/shared/console/jobCommand.ts`) when the app sends it
   (`engineOptions` in `electron/main/queue.ts`); farm export takes its flags from the same table.

The gate fails when the engine reads a field the manifest doesn't list (a), a manifest flag isn't the CLI's or a
render flag isn't in the manifest, or the manifest and `RUN_OPTIONS` disagree (b), a field the app sends has no flag
or Copy as command doesn't write it, or farm export stops using `jobFlags` (c), and when an entry is stale (d). The
behaviour is tested too: representative jobs (every setting off its default) as Copy as command lines and as each
farm format's command, read back by the Console's parser, give the engine the app's own request
(tests/unit/jobCommand.test.ts, farmExport.test.ts).

## Tests

`cargo test -p ck-cli` (no models or card): frame specs and patterns, flags, exit codes, progress lines, the report,
the binary's usage errors, `verify`, `--skip-existing` / `--overwrite`, an orphaned task, the fallback to the app's
install (a fake one in a temp folder). With a model set (CPU, about
40 s), the ignored end-to-end tests: a whole shot and a stepped list against the engine protocol, bit for bit, and a
SIGTERM mid-run:

```sh
cd engine-rs && cargo build -p ck-engine && cargo test -p ck-cli --test e2e -- --ignored --test-threads=1
# CK_TEST_MODELS=<model set> (default the app's 2.0.0-onnx.5), CK_TEST_PRECISION=fp32 for a set with fp32 files
```
