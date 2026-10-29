# Installing on Linux

CorridorKey Desktop for Linux is one file, an AppImage. There's nothing to install system-wide: the keying engine
comes inside it, and the first start downloads the rest.

## What you need

- A 64-bit Linux PC with an **NVIDIA graphics card** (RTX 20-series or newer, 8 GB or more) and NVIDIA's own driver
  loaded. The engine keys only on CUDA: AMD and Intel graphics aren't supported, and nothing falls back to the
  processor. (AMD cards: see [AMD cards (untested)](#amd-cards-untested) below.)
- A recent NVIDIA driver. The GPU runtime the app downloads is CUDA 13, which needs driver 580 or newer
  ([docs/ENGINE_RUST.md](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/docs/ENGINE_RUST.md#build-and-run)).
- ffmpeg (the app helps you install it, below).
- Disk space for the GPU runtime and the models (the sizes are in the README's
  [Install size](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/README.md#install-size) and
  [Uninstall](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/README.md#uninstall) sections).

The engine is built to run on any Linux that Electron runs on: Ubuntu 20.04 and newer, Debian 10 and newer, and
current Fedora and Arch.

## 1. Download and make it executable

1. Download `CorridorKey-Desktop-<version>.AppImage` from the
   [releases page](https://github.com/MarcelineVPQ/corridorkey-desktop/releases).
2. Make it executable. In a terminal:

   ```
   chmod +x CorridorKey-Desktop-*.AppImage
   ```

   or, in your file manager, open the file's Properties and tick "Allow executing file as program" (or similar).
3. Double-click it, or run `./CorridorKey-Desktop-<version>.AppImage`.

Keep the AppImage in a folder of its own (for example `~/Applications`): when the app updates itself, it puts the
new version next to the old one (see [Updates and channels](Updates-and-Channels)).

## 2. First-run setup

The first time, CorridorKey opens **Set up CorridorKey**: three steps, each ticked when it's done.

### Step 1: Download the GPU runtime and the CorridorKey models

Press **Download and install**. The button shows the size of the download; it happens once.

- **The GPU runtime:** ONNX Runtime (Microsoft, MIT licence) and NVIDIA's CUDA and cuDNN libraries (NVIDIA
  licence), downloaded directly from pypi.org.
- **The CorridorKey models:** Corridor Digital's networks, converted for ONNX Runtime, under the CorridorKey licence,
  from this project's GitHub releases.

Everything goes into `~/.local/share/corridorkey-desktop` (or `$XDG_DATA_HOME/corridorkey-desktop` if you set
`XDG_DATA_HOME`). Every file is checked against its SHA-256 before it's used.

The progress line says what it's doing ("Downloading NVIDIA cuDNN", "Unpacking …") and how much is done. **Stop**
pauses it; **Try again (resumes)** carries on where it stopped, keeping the files that already arrived. Before it
starts, the app checks there's enough free disk space and says so if there isn't.

If no NVIDIA driver is loaded, the button stays off and the step says: "No NVIDIA graphics driver is loaded.
CorridorKey Desktop runs on NVIDIA graphics cards." See [Troubleshooting](Troubleshooting#no-nvidia-graphics-driver-is-loaded).

### Step 2: ffmpeg, for reading and writing video

CorridorKey reads and writes video with your system's ffmpeg (it isn't bundled). The app checks that ffmpeg and
ffprobe are there and that ffmpeg can write what the outputs need: **libx264 with 10-bit** support, and the
**DNxHR** encoder (`dnxhd`).

If it's missing, the step shows the install command for your system:

| System | What the app does |
| --- | --- |
| Ubuntu, Debian and their family | **Install ffmpeg** runs `apt update` and `apt install ffmpeg`; your desktop asks for your password |
| Arch and its family | **Install ffmpeg** runs `pacman -S ffmpeg`; your desktop asks for your password |
| Fedora | Fedora's own ffmpeg can't write H.264: enable [RPM Fusion](https://rpmfusion.org/Configuration), then run `sudo dnf install ffmpeg --allowerasing` |
| Rocky, Alma and other RHEL-family systems | Enable EPEL and RPM Fusion, then run `sudo dnf install ffmpeg` |
| openSUSE | Add the Packman repository, then run `sudo zypper install ffmpeg` |
| SteamOS, Bazzite, Silverblue, Kinoite and other read-only systems | The app can't install packages there: add ffmpeg the way your system recommends |

Where the app can't install it, the command is shown for you to copy and run in a terminal. The step ticks itself
once a usable ffmpeg is found.

### Step 3: Add your first clip

Drop a video file, a folder of frames or a folder of clips onto the window, or use **Add clips…** / **Add folder…**.
Then carry on with [Your first key](Your-First-Key).

You can bring the setup back at any time from the **Engine** page: **Open the setup**.

## Optional: TensorRT

On Linux you can switch on NVIDIA TensorRT for faster keying once the setup is done. It's off by default and has
its own download: see [TensorRT](TensorRT).

## AMD cards (untested)

The app has an AMD path on Linux, **off by default and not yet tested on a real AMD card**. To try it, start the
AppImage with the switch set:

```
CK_AMD=1 ./CorridorKey-Desktop-*.AppImage
```

With the switch on and no NVIDIA driver loaded, the setup looks for an AMD card ROCm 10.1's MIGraphX supports (Radeon
RX 7000 and RX 9000, Radeon AI PRO R9700, Ryzen AI graphics, Instinct MI200, MI300 and MI350) and downloads ONNX
Runtime, AMD's ROCm 10.1 and MIGraphX libraries (0.94 to 2.6 GB, depending on the card) and MIGraphX's two extra
model files (0.61 GB). Nothing is installed system-wide. Your user must be in the `render` and `video` groups
(`sudo usermod -aG render,video $USER`, then log out and back in); the setup says so when it isn't. The first job at
each size compiles every network for the card ("Preparing for this graphics card"), which can take minutes; later
jobs reuse it. Details: [docs/AMD.md](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/docs/AMD.md).
