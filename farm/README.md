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
- Paths go through Deadline's path mapping.
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
