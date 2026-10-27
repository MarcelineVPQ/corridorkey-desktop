# CorridorKey Desktop

> **A community project, not made or endorsed by Corridor Digital.** The CorridorKey model is theirs; their official
> app and plugins are at [corridorkey.com](https://corridorkey.com).

CorridorKey Desktop is a free desktop app for [CorridorKey 2.0](https://github.com/nikopueringer/CorridorKey2.0),
Corridor Digital's AI green and blue screen keyer (model by Zachary Harris). You drop your clips in, pick a hint and
the outputs you want, and the app keys them on your own graphics card, showing real progress as it goes: frames
written, the temporal window it chose, and stills of the results.

The model is Corridor's, unchanged. What's new is the engine around it: the same networks running on a Rust engine
with ONNX Runtime (no Python), inside an app that downloads what it needs by itself. It's free and it stays free.
Huge thanks to Niko, Zachary Harris and the Corridor crew for CorridorKey. If you work inside Resolve, Nuke, After
Effects, Premiere or Blender, Corridor's own app and plugins are at [corridorkey.com](https://corridorkey.com).

How it compares with the original on speed, memory and mattes is measured, with the clips and commands to check it
yourself, in the README: [Speed](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/README.md#speed) and
[Quality](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/README.md#quality-the-mattes-against-the-original-and-the-truth).

## Who it's for

VFX artists, compositors and editors who want CorridorKey's mattes as files: a matte, a foreground, a cutout or a
checker preview, as EXR sequences for compositing or as 10-bit video for the edit.

## Platforms

| System | Status in 1.0.0-dev.1 |
| --- | --- |
| Linux (AppImage, x64) | Keys with an NVIDIA graphics card. Optional TensorRT mode. |
| Windows 10/11 (installer, x64) | Installs, sets itself up and runs its pages. **Keying on a real Windows PC with an NVIDIA card hasn't been tested yet**: please tell us how it goes. |
| macOS (Apple Silicon) | No build yet: the Mac engine can't key yet. It's being worked on. |

On Linux and Windows an **NVIDIA graphics card is required** (RTX 20-series or newer, 8 GB or more). AMD and Intel
graphics cards aren't supported, and nothing falls back to the processor. The details are in the README's
[Requirements](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/README.md#requirements).

## Pages

- [Installing on Linux](Installing-on-Linux): the AppImage, first-run setup, ffmpeg, the NVIDIA driver
- [Installing on Windows](Installing-on-Windows): the installer, SmartScreen, first-run setup, ffmpeg
- [Your first key](Your-First-Key): add clips, set them up, start, and find the results
- [Hints](Hints): telling the model what the subject is
- [Outputs](Outputs): EXR, lossless H.264, DNxHR 444, and which to pick
- [Graphics memory and the window](Graphics-Memory-and-the-Window): the temporal window, memory limit, low-memory mode
- [TensorRT](TensorRT): the optional faster mode on Linux
- [Updates and channels](Updates-and-Channels): Stable and Development, updating on Linux and Windows
- [Troubleshooting](Troubleshooting): every message the app shows, what it means and what to do
- [Uninstall](Uninstall): removing the app and everything it downloaded

For power users and studios (in the next development build, 1.0.0-dev.2):

- [Command line](Command-Line): `corridorkey`, every command and flag, exit codes, progress lines, the report
- [Render farm](Render-Farm): Deadline, AWS Deadline Cloud / OpenJD, OpenCue, Flamenco, or a shell loop
- [Console](Console): the command line inside the app, with scripting, bookmarks, `doctor` and farm export

- [Building from source](Building-from-Source): for developers
- [What's coming](Whats-Coming)

## Licence and credits

CorridorKey is © Corridor Digital, under the CorridorKey licence
([LICENSE](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/LICENSE)). This app is free. Organisations
with more than US $20M annual revenue need CorridorKey plugin seats from [corridorkey.com](https://corridorkey.com).
Foundation models: C-RADIO (NVIDIA), MoGe (Microsoft), RVM (Google DeepMind). Built by Marcy
([MarcelineVPQ](https://github.com/MarcelineVPQ)) at 42 Pixel Studios.
