# Guide

CorridorKey Desktop keys green and blue screen footage with CorridorKey 2.0, Corridor Digital's AI keyer, on your own graphics card.

## Getting started

1. The first time, open **Engine** in the rail and press **Download and install** under *Runtime and models*: the GPU runtime and the CorridorKey models (a 4.9 GB download, once). If ffmpeg is missing, the same page offers to install it. The engine itself comes with the app.
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

## Outputs

**Video** writes 10-bit previews (alpha, foreground, checker) and a ProRes 4444 cutout. **EXR sequence** writes scene-linear, unclamped HDR frames for compositing. Despill applies to the checker and cutout.

## Appearance

App settings → Appearance: **System**, **Light**, **Dark** or **Desktop** (your desktop's own colors, followed live), the accent color, and **Glass**.
