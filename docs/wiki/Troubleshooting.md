# Troubleshooting

Every message below is shown by the app or its engine exactly as quoted (parts in `<angle brackets>` are filled in).
A failed clip's page has a heading for the kind of problem, the engine's message under it, and **Run again**. Its
log is saved next to the results as `<clip>_log_failed.txt` (see [Your first key](Your-First-Key#the-job-log)).

If something here doesn't help, please [open an issue](https://github.com/MarcelineVPQ/corridorkey-desktop/issues)
with the job's log (**Copy log** on the clip's page) and its `<clip>_settings.txt`.

**Contents:** [Setup and downloads](#setup-and-downloads) · [ffmpeg](#ffmpeg) · [The engine](#the-engine) ·
[Job errors](#job-errors) · [Can't read this clip](#cant-read-this-clip) · [TensorRT wasn't used](#tensorrt-wasnt-used) ·
[The command line](#the-command-line) · [Other messages](#other-messages)

## Setup and downloads

### No NVIDIA graphics driver is loaded

> No NVIDIA graphics driver is loaded. CorridorKey Desktop runs on NVIDIA graphics cards.

**Cause:** the app didn't find NVIDIA's driver: on Linux it looks for the loaded NVIDIA kernel driver, on Windows for
NVIDIA's driver library in the system folder. The download button stays off, since the runtime would be no use.

**Fix:** CorridorKey needs an NVIDIA graphics card (RTX 20-series or newer) with NVIDIA's own driver. On Linux, the
open-source `nouveau` driver isn't enough: install your distribution's NVIDIA driver and restart. The GPU runtime
needs driver 580 or newer. AMD and Intel graphics aren't supported.

### Not enough free disk space

> not enough free disk space: it needs `<size>` in `<folder>`, `<size>` is free

**Cause:** the install checks the space first, counting room to unpack the runtime next to its downloads. Files a
stopped install already downloaded are counted as there.

**Fix:** free up that much space on the drive holding the data folder (`~/.local/share/corridorkey-desktop` on Linux,
`%LOCALAPPDATA%\corridorkey-desktop` on Windows), then press **Try again (resumes)**.

### The download stops, stalls or is refused

| Message | Cause |
| --- | --- |
| the download stopped (no data for a minute) | nothing arrived for 60 seconds |
| the download server didn't answer | no connection within 20 seconds, or the connection failed |
| the download failed (HTTP `<code>`) | the server refused the file |
| refused: the download is `<n>` bytes, the app's list says `<m>` | the file came out the wrong size |
| refused: the download's SHA-256 doesn't match the app's list | the file isn't exactly the one the app expects |
| the download was stopped | you pressed **Stop** |

**Fix:** check your connection and press **Try again (resumes)**. A stopped or stalled download keeps what arrived
and continues from there; files that finished are checked again offline and kept. A refused file is deleted and
downloaded again. Nothing is used until every file is in place and checked: the runtime and the models only appear
once complete.

### `<file>` had none of the expected libraries

**Cause:** a downloaded package unpacked without the libraries it should hold. **Fix:** press **Try again**; if it
repeats, please open an issue.

### Install the GPU runtime and the CorridorKey models first

**Cause:** you started the TensorRT download before the normal setup. **Fix:** finish step 1 of the setup (Engine
page, **Runtime and models**), then TensorRT.

## ffmpeg

The setup's step 2 and the Engine page's **ffmpeg** section show these.

| Message | Cause and fix |
| --- | --- |
| ffmpeg isn't installed (ffprobe not found) | No ffmpeg on this system. Install it (the app offers to, or shows the command; see [Linux](Installing-on-Linux#step-2-ffmpeg-for-reading-and-writing-video) or [Windows](Installing-on-Windows#step-2-ffmpeg-through-winget)). |
| ffmpeg isn't installed (ffprobe is, ffmpeg isn't) | Only half of ffmpeg is there. Install the full ffmpeg package. |
| ffprobe didn't answer (`<reason>`) / ffmpeg didn't answer (`<reason>`) | The program is there but didn't run properly within 15 seconds. Run `ffmpeg -version` in a terminal to see why. |
| This ffmpeg can't write libx264 or dnxhd (a build without it) | A patent-free build without the H.264 encoder (Fedora's and openSUSE's own packages, for example) or without DNxHR. Install a full build: RPM Fusion on Fedora, Packman on openSUSE. |
| This ffmpeg's libx264 is 8-bit only: it can't write the 10-bit 4:4:4 video outputs. Install an ffmpeg whose libx264 has 10-bit | The video outputs are 10-bit. Install an ffmpeg whose libx264 supports 10-bit. |
| pkexec isn't available: run "`<command>`" in a terminal | Your desktop has no password prompt the app can use. Run the shown command yourself. |
| the password prompt was cancelled | Press **Install ffmpeg** again and enter your password. |
| the install failed (`<last line>`): run "`<command>`" in a terminal to see more | The package manager failed (often no network, or a package source error). Run the command yourself to see the whole message. |

On a read-only system (SteamOS, Bazzite, Silverblue and similar), the app can't install packages and says so: add
ffmpeg the way your system recommends.

## The engine

### The engine didn't start: `<reason>`

**Cause:** the engine program couldn't start with the runtime and models it found. **Fix:** open the **Engine**
page: it lists the engine program, the models folder and the ONNX Runtime library it uses, and what's missing. If
files are missing, **Open the setup** downloads them again.

### Windows Defender quarantined `corridorkey.exe`

**Cause:** the Windows builds aren't code-signed yet, and Defender's machine-learning check can flag the app's
unsigned command-line program (`resources\engine\corridorkey.exe`) as `Trojan:Win32/Bearfoos.A!ml`. It is a false
positive: the program is built from this repository's open source, and each new build is sent to Microsoft to clear
it. **Fix:** in Windows Security, **Protection history**, choose the entry and **Restore** (or **Allow on device**),
then run the job again.

### The engine stopped unexpectedly (`<signal or exit code>`).

**Cause:** the engine process ended in the middle of a job (it crashed, or something outside the app ended it). The page shows the engine's last error output under the message. **Fix:** press **Run again**. If
it happens again, please open an issue with the log.

## Job errors

### No supported graphics card found

> CorridorKey needs an NVIDIA graphics card with CUDA.

On Linux the message is:

> CorridorKey needs an NVIDIA graphics card with CUDA, or an AMD graphics card with ROCm and AMD's MIGraphX plugin (docs/AMD.md).

**Cause:** the engine found no NVIDIA card it can use with CUDA (and, on Linux, no AMD card through AMD's MIGraphX
plugin: the app sets AMD cards up only behind a switch that is off by default, untested on a real AMD card so far:
[docs/AMD.md](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/docs/AMD.md)). **Fix:** see
[No NVIDIA graphics driver is loaded](#no-nvidia-graphics-driver-is-loaded). Nothing runs on the processor instead.

On a Mac the message is:

> On a Mac, CorridorKey runs on Apple's Core ML: start the engine with --device coreml (CK_ENGINE_DEVICE=coreml; the app does this).

**Cause:** the engine was asked for another device, such as `--device cuda` (from 1.0.0-dev.3 the default, `auto`,
is Core ML on a Mac; before it, the command line needed `--device coreml`). **Fix:** leave `--device` out, or pass
`--device coreml`.

On Linux with AMD's MIGraphX provider plugin installed (an AMD card; untested on a real AMD card so far) the message
is:

> CorridorKey found no AMD graphics card ROCm can use (HIP sees no device, or the amdgpu driver's memory files are missing; check rocminfo).

**Cause:** the MIGraphX plugin loaded, but ROCm sees no AMD card the engine can read. **Fix:** check that `rocminfo`
lists the card and that the amdgpu driver is loaded.

### The graphics card ran out of memory

> The graphics card ran out of memory (`<what it was doing>`): `<details>`

**Cause:** the job needed more graphics memory than was free. With the **Automatic** window the engine already tried
smaller windows by itself before giving up, if the memory ran out before any frame was written (see
[Graphics memory and the window](Graphics-Memory-and-the-Window#running-out-of-memory)).

**Fix:**
- Close other programs using the graphics card (the Queue page names them while a job runs).
- Choose **Manual** memory with a smaller window and **Low-memory mode**.
- Lower the **Internal resolution** (¾, ½ or ¼).
- If you set a **Memory limit** and a Manual window, make sure the window's estimate fits under it.

### The clip or a hint couldn't be read

| Message | Cause and fix |
| --- | --- |
| This clip is too large (`<w>x<h>`): the engine takes at most 16384 pixels in each direction. | The engine takes frames up to **16384 pixels** wide and tall. Scale the plate down first. |
| At this model scale the networks would run at `<w>x<h>` (the clip is `<w>x<h>`): the engine takes at most 16384 pixels in each direction. Choose a smaller model scale. | Lower the **Internal resolution**. |
| This clip is too small (`<w>x<h>`): CorridorKey's networks need more than 128 pixels in each direction. | The clip is too small for the networks. |
| `<frame>`: frame size `<w>x<h>` differs from the first frame's `<w>x<h>` | Every frame in a frame folder must be the same size. |
| `<file>`: `<w>x<h>` is larger than the engine takes (16384 pixels in each direction) | A frame or hint image is past the 16384 px limit. |
| Hint video `<file>` has only `<n>` frames, but the source video requires `<m>` frames | A hint video needs at least as many frames as the clip. |
| Hint video `<file>`: `<w>x<h>` is larger than the engine takes (16384 pixels in each direction) | Render the hint smaller. |
| No frames found under `<folder>` | The folder has no `.exr`, `.png`, `.jpg` or `.jpeg` frames. |
| input not found: `<path>` | The clip or hint was moved, renamed or is on a drive that isn't connected. |
| Could not open video: `<file>` (`<what ffprobe said>`) | ffprobe couldn't read the file: usually a damaged file, or a codec your ffmpeg can't decode. |
| No hint frame found at `<path>` | The first-frame matte isn't at that path, or the folder has no image in it. Choose the hint again. |
| Portrait clips (taller than wide, here `<w>x<h>`) need the 2.0.0-onnx.3 models or newer: this models folder's C-RADIO only takes landscape or square frames. | An older model set was chosen by hand on the Engine page. Set the models back to **Automatic** (the set this version of the app downloads). |

### DNxHR 444 needs a frame of at least 256x120; this clip is `<w>x<h>` (H.264 takes any size)

Shown under **The job failed**. **Cause:** ffmpeg's DNxHR encoder refuses frames smaller than **256×120**; the engine
checks before keying starts, so no time is wasted. **Fix:** pick **Lossless H.264** or **H.264 CRF 12** under
**Outputs → Codec**, or EXR.

### Model files are missing

> missing ONNX model(s) `<names>` (`<precision>`) in `<folder>`

**Cause:** the models folder the engine uses is incomplete (for example after removing the models in App settings →
Storage, or a models folder chosen by hand on the Engine page). **Fix:** **Engine → Open the setup** downloads them
again, or set the Engine page's models choice back to Automatic.

### The results couldn't be written

> Can't write the output folder `<folder>`: not allowed to write there / the drive is read-only / the disk is full (`<details>`)

Also: "Couldn't create the output folder `<folder>`: `<reason>`".

And for the job's temporary files (the cache folder, or the command line's `--temp`): "Can't write the job's
temporary files: `<reason>` (`<details>`)". Free up space on that drive, or choose another cache folder in
**App settings → Storage**.

**Fix:** free up space, or choose a folder you can write to: **App settings → Results → Where results go** (for clips
added from then on). Started files of a failed job are removed; earlier results in the folder are left alone.

> The results are complete but couldn't be moved into `<folder>` (`<reason>`); what wasn't moved is in its .corridorkey-partial folder.

**Cause:** the job finished, but moving its files from the hidden `.corridorkey-partial` folder into the results
folder failed. **Fix:** your results are in that `.corridorkey-partial` folder inside the results folder (show hidden
files): move them out by hand.

## Can't read this clip

A clip the app can't read gets **Can't read this clip** on its row, with the reason, and won't run. Common reasons:

| Reason | What it means |
| --- | --- |
| no video stream | The file has no video in it (an audio file, or a damaged file). |
| no EXR/PNG/JPG frames in this folder | The folder you added has no frames the app reads. |
| not an image | A frame in the folder isn't a readable image. |
| any other text | ffprobe's own first line about the file: usually a damaged file, or a codec your ffmpeg can't decode. |

Remove the clip (the bin icon on its row), fix or convert the file, and add it again. Reading a clip times out after
two minutes, so a stalled network drive gives a reason instead of holding up the queue.

## TensorRT wasn't used

On Linux with TensorRT on, a job's **Technology for this run** says what ran and why. "not asked" means the app
didn't ask for TensorRT; "not used" means the engine couldn't use it for this job.

| Message | Cause and fix |
| --- | --- |
| not asked: TensorRT is off (Engine settings) | Switch it on in Engine settings, TensorRT. |
| not asked: TensorRT's parts weren't installed when the job started (Engine settings, TensorRT) | Finish TensorRT's download. |
| not used: TensorRT for this resolution range isn't built yet | Jobs never wait on a build. Let the background build finish, or press **Build for this clip's size**. |
| not used: TensorRT for this resolution is built for a window of `<n>` frames; this job's automatic window is `<m>` | A range is used only at the window it was built for (see [TensorRT](TensorRT#a-range-is-used-only-at-the-window-it-was-built-for)). A short clip or a memory limit can change the window. |
| not used: `<w>x<h>` is outside the TensorRT ranges (more than 4096 px a side, or a larger frame than 4096x2176, runs on CUDA) | Open gate, 6K and larger frames always run on CUDA. |
| not used: this ONNX Runtime has no TensorRT provider | Reinstall TensorRT's parts (Engine settings, TensorRT). |
| not used: the models folder has no TensorRT-ready models | The TensorRT models aren't in the models folder in use; reinstall TensorRT's parts. |
| not used: TensorRT needs the graphics card | The job didn't run on the graphics card. |
| `<network>` on CUDA (`<reason>`) | TensorRT couldn't build that one network for this range (for example stage 1 at long windows); it runs on CUDA, the rest on TensorRT. |

In Engine settings, TensorRT:

- "Installed for the downloaded runtime and models, but the engine uses other files (ONNX Runtime engine, below), so
  jobs run on CUDA." You chose another runtime or models folder by hand on the Engine page; set them back to
  Automatic.
- "Not started: `<program>` is using the graphics card. It starts by itself once the card is free; Build now starts it
  anyway."
- "The background build stopped: `<reason>`", or a size's "couldn't be built: `<reason>`": press **Build now** to try
  again; what was built is kept.
- The log line "TensorRT: the graphics driver changed; engines built for `<folders>` can't be used and were removed"
  means they're built again for the new driver. "TensorRT: engines built for `<folders>` (another TensorRT or ONNX
  Runtime) weren't used for 30 days and were removed" frees the disk of an older version's engines; a folder another
  installed copy still uses is kept.

## The command line

The `corridorkey` command line (from 1.0.0-dev.2) prints the same engine messages as
the app, and ends with an exit code that says what kind of problem it was and whether a retry can help: see
[Command line, exit codes](Command-Line#exit-codes). In the app's [Console](Console), `doctor` checks the whole setup
in one go and says how to fix each problem.

## Other messages

| Message | Meaning |
| --- | --- |
| **Start queue** greyed out | Hover it for the reason: "Set up the engine first (Engine page)", "Install ffmpeg first (Engine page)", "Moving the cache folder… the queue can start when it's done", or "Add a clip that's ready to run". |
| Choose the first-frame matte, or pick No hint / Choose the hint video, or pick No hint | The clip's hint mode needs a file. See [Hints](Hints). |
| Other programs are using the graphics card | Shown on the Queue page while a job runs: the automatic window gets smaller when less memory is free, and both run slower. |
| Drive not available for the cache folder: `<folder>` | The cache folder you chose is on a drive that isn't connected. The app uses the default folder for now, moves and deletes nothing, and goes back to your choice when the drive is there at the next start. **App settings → Storage** has **Use the default folder from now on**. |
| The log couldn't be saved: `<reason>` | The results folder couldn't take the log file. **Copy log** still works. |
| Not while the queue or the download runs | Storage items can't be removed while they're in use. |
| An update refused | See [Updates and channels](Updates-and-Channels). The app shows why as it is and installs nothing. |
