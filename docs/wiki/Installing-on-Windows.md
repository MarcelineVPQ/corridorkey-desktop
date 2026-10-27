# Installing on Windows

> **Keying on Windows hasn't been tested on a real NVIDIA PC yet.** The Windows build is tested in a Windows 11
> virtual machine: it installs, opens, runs its setup (the downloads, ffmpeg through winget) and works through its
> pages. That machine has no NVIDIA graphics card, so a real job on Windows is still untested, and every speed and
> quality number in the README was measured on Linux. If you try it, please
> [tell us how it goes](https://github.com/MarcelineVPQ/corridorkey-desktop/issues), whether it works or not.

## What you need

- Windows 10 or 11, 64-bit, with an **NVIDIA graphics card** (RTX 20-series or newer, 8 GB or more) and NVIDIA's
  driver installed. The engine keys only on CUDA: AMD and Intel graphics aren't supported, and nothing falls back to
  the processor.
- A recent NVIDIA driver. The GPU runtime the app downloads is CUDA 13, which needs driver 580 or newer
  ([docs/ENGINE_RUST.md](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/docs/ENGINE_RUST.md#build-and-run)).
- ffmpeg (the app installs it for you with winget, below).
- Disk space for the GPU runtime and the models (sizes in the README's
  [Uninstall](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/README.md#uninstall) table).

## 1. Run the installer

1. Download `CorridorKey-Desktop-<version>-Setup.exe` from the
   [releases page](https://github.com/MarcelineVPQ/corridorkey-desktop/releases).
2. Run it. The installer isn't code-signed yet, so the first time Windows SmartScreen says **"Windows protected your
   PC"**. Click **More info**, then **Run anyway**. Signing comes later.
3. The install is **per user**: no administrator rights needed. You can choose the install folder. It adds a desktop
   shortcut called CorridorKey.

## 2. First-run setup

The first time, CorridorKey opens **Set up CorridorKey**: three steps, each ticked when it's done.

### Step 1: Download the GPU runtime and the CorridorKey models

Press **Download and install**. The button shows the size of the download; it happens once.

- **The GPU runtime:** ONNX Runtime (Microsoft, MIT licence), NVIDIA's CUDA and cuDNN libraries (NVIDIA licence) and
  Microsoft's Visual C++ runtime, downloaded directly from pypi.org.
- **The CorridorKey models:** Corridor Digital's networks, converted for ONNX Runtime, under the CorridorKey licence,
  from this project's GitHub releases.

Everything goes into `%LOCALAPPDATA%\corridorkey-desktop`. Every file is checked against its SHA-256 before it's used.
**Stop** pauses the download; **Try again (resumes)** carries on where it stopped. Before it starts, the app checks
there's enough free disk space.

If Windows has no NVIDIA driver loaded, the button stays off and the step says: "No NVIDIA graphics driver is loaded.
CorridorKey Desktop runs on NVIDIA graphics cards." See [Troubleshooting](Troubleshooting#no-nvidia-graphics-driver-is-loaded).

### Step 2: ffmpeg, through winget

CorridorKey reads and writes video with ffmpeg. If it isn't found, press **Install ffmpeg**: the app runs

```
winget install --id Gyan.FFmpeg -e
```

for you (Windows may ask for permission). The app finds the new ffmpeg straight away, without a restart. If you'd
rather do it yourself, run the same command in a terminal.

### Step 3: Add your first clip

Drop a video file, a folder of frames or a folder of clips onto the window, or use **Add clips…** / **Add folder…**.
Then carry on with [Your first key](Your-First-Key).

You can bring the setup back at any time from the **Engine** page: **Open the setup**.

## Not on Windows yet

- **TensorRT** is Linux-only in this version: on Windows it needs its own engine builder, which comes later. Jobs run
  on CUDA.
- **Self-update** is Linux-only for now: on Windows, new versions are on the releases page (see
  [Updates and channels](Updates-and-Channels)).
