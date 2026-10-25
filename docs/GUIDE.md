# Guide

> **A community project, not made or endorsed by Corridor Digital.** The CorridorKey model is theirs; their official
> app and plugins are at [corridorkey.com](https://corridorkey.com).

CorridorKey Desktop keys green and blue screen footage with CorridorKey 2.0, Corridor Digital's AI keyer, on your own graphics card.

## Getting started

1. The first time, CorridorKey opens its **setup**: three steps, each ticked when done. Download the GPU runtime and the CorridorKey models (a 4.9 GB download, once), install ffmpeg if it's missing (the app offers to), and add your first clip. The engine itself comes with the app. **Engine → Open the setup** brings it back.
2. Open **Queue** and drop clips, frame folders or a folder of clips anywhere on the window, or use **Add clips**.
3. Pick a clip; its settings are in the panel on the right. Press **Start queue**.

## The rail

The rail on the right takes you to the pages. Hover it for names, or press **Ctrl+B** to keep it open. The lock in its bottom corner keeps it icons-only. Pressing the page you're on shows or hides its settings panel. A yellow dot on an icon means something is waiting there; pressing it takes you to it.

## Hints

- **No hint:** the model decides what the subject is. Fastest to set up.
- **First-frame matte:** a matte for the first frame (white = subject). Usually the best practical choice.
- **Hint video:** a matte for every frame (a roto pass, a garbage matte, an automatic mask).

A matte named like the clip (`shot01FrameHint.png`, `shot01_AlphaHint.mp4`) is found and selected when the clip is added. **Hint trust** tells the model how far to trust your matte: 0.95 for an artist's matte, 0.75 for a rough automatic one, 0.5 or less for a loose one.

## Graphics memory

**Automatic** picks the largest temporal window that fits the graphics memory free when the job starts. Bigger windows give steadier mattes over time. While a job runs, the Queue page shows the window it really used and the free memory it saw. If another program uses the card, the page names it.

**Manual** lets you pick the window yourself (Window / stride) and Low-memory mode. Each choice shows the engine's estimate of the graphics memory it will take for the selected clip ("24 / 12 · about 11.3 GiB" for an HD clip), the Low-memory checkbox shows both modes for the window picked, and a Graphics memory line says "About X GiB of Y GiB free on this card: fits" or "doesn't fit". The number is the engine's own (the same estimate its Automatic choice uses), not the app's: opening the section starts the engine for a moment (about 0.15 s; it loads no model and takes no graphics memory) to read the clip's size and the card's free memory, then it quits. While the queue runs the engine is busy, so the line shows the last reading, marked as read before the queue started. "Doesn't fit" means the engine's safety margin isn't met: the job may still run, or may stop out of memory. The estimate is the upstream runtime's table, not a guarantee: measured on an RTX 5080 it came within −21 % to +19 % of the real peak (docs/BACKLOG.md row 41), so leave some room.

## Outputs

**Video** writes display-referred (sRGB / Rec.709) 10-bit 4:4:4 files in the codec you pick under **Codec**:
**Lossless H.264** (the default; only the 10-bit rounding is lost, large `.mp4` files), **DNxHR 444** (Avid's 10-bit
edit and finishing codec, `.mov`, the matte within 1.3/255) or **H.264 CRF 12** (the original's small files; hair edges off by up to
21/255). README, Quality, "Video outputs" has the measurements. On a Mac it is lossless H.264 for now; Apple's
ProRes 4444 XQ comes with the Mac release. None of these carries an alpha channel, so a video **cutout** is the
despilled colour premultiplied by the matte, and its alpha is the **Alpha** output, which stays on while Cutout is
on. For an RGBA cutout in one file, choose EXR. **EXR sequence** is the exact deliverable: scene-linear, unclamped HDR frames for compositing, named the studio way
(`shot_alpha.1001.exr`; a numbered frame folder keeps its own frame numbers), with the matte in the alpha channel
and the cutout premultiplied, as Nuke expects. Despill applies to the checker and cutout.

## Appearance

App settings → Appearance: **System**, **Light**, **Dark** or **Desktop** (your desktop's own colors, followed live), the accent color, and **Glass**.
