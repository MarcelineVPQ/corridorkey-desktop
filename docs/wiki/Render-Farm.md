# Render farm

> **New in 1.0.0-dev.2.** The [command line](Command-Line) and these submitters aren't in 1.0.0-dev.1. The
> submitters are in the repository's
> [farm/](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/farm/README.md) folder.

CorridorKey keys on a farm through its command line, `corridorkey`. The repository has a submitter for each common
scheduler, and the app's [Console](Console) writes ready-to-submit jobs for the clips in its queue (`farm export`).

**Contents:** [Before you start](#before-you-start) · [From the app: farm export](#from-the-app-farm-export) ·
[OpenJD and AWS Deadline Cloud](#openjd-and-aws-deadline-cloud) · [Deadline 10](#deadline-10) · [OpenCue](#opencue) ·
[Flamenco](#flamenco) · [No scheduler: the shell loop](#no-scheduler-the-shell-loop) ·
[What's tested](#whats-tested)

## Before you start

**One whole shot per task.** That gives the app's matte, bit for bit. Splitting a shot into chunks works (`--frames`
per task with `--preroll` / `--tail` warm-up frames), but a chunk is only near-identical to the whole shot, and how many
warm-up frames make the seams invisible hasn't been measured yet. Every submitter keys whole shots by default; chunks
are opt-in, with warm-up 0 ([Command line: warm-up](Command-Line#warm-up-and-chunks)).

**Each worker needs:**

- the `corridorkey` command ([where it is](Command-Line#where-it-is));
- the model set's folder (`--models`) and ONNX Runtime's library (`--ort`): copy them from a machine where the app
  set itself up (`~/.local/share/corridorkey-desktop/models/<set>` and `…/runtime/…`), or install the app on the
  worker, in which case `corridorkey` finds them by itself;
- ffmpeg, for movie inputs;
- an NVIDIA graphics card (RTX 20-series or newer, 8 GB or more), as for the app.

Check each worker once before the first job; it exits 0 when it can key:

```sh
corridorkey prepare --models /opt/ck/models/2.0.0-onnx.5 --ort /opt/ck/runtime/libonnxruntime.so.1.31.0
```

**A retried task replaces its own frames.** Every submitter passes `--overwrite`, because a retry finds the frames its
first try already put in place. Frames only ever appear whole (a killed task leaves none at a final name).

**Exit codes** say whether a retry can help (2: fix the command; 6: out of graphics memory; 9: `verify` found a frame
missing): [Command line: exit codes](Command-Line#exit-codes). `corridorkey` never exits 33 or 137 (OpenCue's retry
codes).

## From the app: farm export

In the [Console](Console), `farm export <format>` writes the queued clips as farm jobs, with the settings each clip
has in the queue:

```
farm export openjd --queue -o ~/farm/sq01 --models /opt/ck/models --ort /opt/ck/libonnxruntime.so
farm export deadline sh010.mov -o ~/farm/sh010 --group gpu --priority 60
farm export opencue --queue -o ~/farm/sq01
farm export flamenco --queue -o ~/farm/sq01 --platform linux
farm export shell --queue -o ~/farm
```

- **Where the frames land:** where the app's queue puts them, `<results>/<clip>_alpha_exr/<clip>_alpha.1001.exr`.
- **`--models` and `--ort`** are the workers' paths. Without them the jobs carry this computer's paths, and the
  export says so.
- **Deadline:** `--group` (your GPU group; without one the export warns the job may reach a worker without a card),
  `--pool`, `--priority` (0-100, default 50). Each clip gets a Verify job after its render.
- **Flamenco:** `--platform linux|windows|darwin`, the submitting computer's system, so Flamenco's two-way variables
  translate the paths.
- A frame folder that holds several sequences is refused (`corridorkey` keys a whole folder).
- It never replaces job files already in the folder unless you say `sudo farm export … --overwrite`.

## OpenJD and AWS Deadline Cloud

Two job bundles (`jobtemplate-2023-09`) in
[farm/openjd/](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/farm/README.md#openjd):

- `corridorkey/`: one task per shot, then a Verify step.
- `corridorkey-chunked/`: a frame range in chunks (`TASK_CHUNKING`; Deadline Cloud allows at most 150 frames per
  task), with Preroll and Tail (0 by default), then Verify over the whole range.

**Install:** the [OpenJD CLI](https://github.com/OpenJobDescription/openjd-cli) to try a bundle locally; the Deadline
Cloud CLI to submit.

**Submit:**

```sh
openjd check farm/openjd/corridorkey/template.yaml
deadline bundle submit farm/openjd/corridorkey          # or: deadline bundle gui-submit farm/openjd/corridorkey
```

The Key step reads `corridorkey`'s `openjd_progress:` / `openjd_status:` lines, writes a JSON report into the output
folder, and a cancel stops it cleanly (exit 143). Temporary files go in the session's working folder. The host
requirement is a GPU with at least 8192 MiB; edit it in the template for your cards.

## Deadline 10

A Deadline 10 plugin, [farm/deadline10/CorridorKey/](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/farm/README.md#deadline-10),
which reads `corridorkey`'s progress lines.

**Install:** copy the `CorridorKey` folder to `<your repository>/custom/plugins/CorridorKey`. In the Monitor, Tools >
Configure Plugins > CorridorKey: the `corridorkey` executable, the model set folder and the ONNX Runtime library on
your workers (one path per line; each worker uses the first it finds).

**Submit** one task per shot (`ChunkSize` = the shot's length), and a Verify job (`Command=verify`) that depends on it:

```sh
deadlinecommand sh010_job_info.txt sh010_plugin_info.txt
# farm export deadline writes both jobs as one batch:
deadlinecommand -SubmitMultipleJobs -dependent -job sh010_job_info.txt sh010_plugin_info.txt -job sh010_verify_job_info.txt sh010_verify_plugin_info.txt
```

Each task runs `corridorkey render … -s <STARTFRAME> -e <ENDFRAME> --progress-format deadline --overwrite`. Paths go
through Deadline's path mapping. With GPU affinity set on the worker or the job, each task gets `--gpu`. Extra flags
go in `ExtraArguments`; a value with a space in double quotes (`--hint-video "/hints/my hint.mov"`).

## OpenCue

A PyOutline submit script,
[farm/opencue/corridorkey_submit.py](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/farm/README.md#opencue):
a `render` layer (one GPU, 12 GiB of graphics memory and 16 GiB of RAM booked by default; the whole shot as one task)
and a `verify` layer after it.

**Install:** PyOutline (spec version 1.12 or later sends the GPU booking), GPU support on in RQD on the GPU hosts.

**Submit:**

```sh
python3 corridorkey_submit.py --show demo --shot sh010 \
    -i /shows/demo/sh010/plates/sh010.####.exr -o /shows/demo/sh010/key/sh010_key.####.exr \
    --range 1001-1100 --models /opt/ck/models/2.0.0-onnx.5 --ort /opt/ck/runtime/libonnxruntime.so \
    -- --linear --outputs alpha
```

Each render task books graphics memory (`--gpu-memory`, 12 GiB by default) and the engine picks its window from what
the card has free. `--max-vram GB` limits the engine as well; farm export passes a clip's limit from the queue as both. RQD's `CUE_GPU_CORES` picks the card. Commands are quoted for Linux and macOS hosts; Windows hosts
would need their own quoting.

## Flamenco

A Flamenco 3.x job type,
[farm/flamenco/corridorkey.js](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/farm/README.md#flamenco).

**Install:** put it in the `scripts` folder next to the Manager's executable and restart the Manager; "CorridorKey"
appears as a job type. Workers need Flamenco 3.3 or newer (the `exec` command). Use worker tags to keep it on the
machines with a graphics card.

**Submit** from the Manager's job types (or `farm export flamenco`, a job for `POST /api/v3/jobs`). Chunk size 0 is one
task for the whole shot; a `verify` task follows. Flamenco cancels by killing the task: no frame reaches a final name,
and the hidden `.corridorkey-*` folders are cleaned up by the next task writing to that folder.

## No scheduler: the shell loop

[farm/shell/corridorkey-farm.sh](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/farm/README.md#shell) keys a
list of shots, one shot per graphics card at a time (bash; Linux).

```sh
# shots.txt: INPUT OUTPUT [FRAMES] per line, tab-separated; # comments
CORRIDORKEY=/opt/ck/corridorkey farm/shell/corridorkey-farm.sh --gpus 0,1 --logs farm-logs shots.txt -- \
  --models /opt/ck/models/2.0.0-onnx.5 --ort /opt/ck/runtime/libonnxruntime.so.1.31.0 --linear
```

Every shot runs with `--skip-existing`, so running the list again resumes it. Per shot a log and a JSON report; at
the end a table of exit codes, and exit 1 if any shot failed. Ctrl+C or SIGTERM stops each running shot cleanly.

## What's tested

Honestly: **none of the submitters has run on a real scheduler yet.** A studio tester's first run will confirm them;
please [open an issue](https://github.com/MarcelineVPQ/corridorkey-desktop/issues) with what you find.

| Submitter | Tested here | Not tested |
| --- | --- | --- |
| OpenJD | `openjd check` and `openjd summary`; `openjd run` of both bundles on a small movie on the CPU (whole shot, and chunks with preroll and tail), Verify passed; bundles from `farm export` pass `openjd check` | Deadline Cloud itself: its submitter, job attachments, path mapping, host requirements, cancel on a farm; a frame folder as a job attachment |
| Deadline 10 | the plugin's logic with stand-in Deadline modules; the Windows path quoting (a unit test) | a real Deadline: its Python, the Monitor's settings, a worker's output, its cancel signal, which card order its GPU affinity uses |
| OpenCue | the script with stand-in PyOutline modules | a real OpenCue; whether Cuebot accepts a `gpu_memory` like `12g` |
| Flamenco | the job compiler in Node with stand-ins for Flamenco's functions | a real Manager and Worker; Blender's submission form |
| Shell loop | two shots on the CPU, a rerun skipping them, a SIGTERM mid-run (exit 143), two lanes with a stub | real graphics cards, macOS's bash 3.2 |

The command line itself is tested without a graphics card (its frames, flags, exit codes, progress, report, signals)
and end to end on the CPU against the app's engine, bit for bit.
