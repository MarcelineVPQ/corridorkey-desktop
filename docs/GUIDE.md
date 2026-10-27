# Guide

> **A community project, not made or endorsed by Corridor Digital.** The CorridorKey model is theirs; their official
> app and plugins are at [corridorkey.com](https://corridorkey.com).

CorridorKey Desktop keys green and blue screen footage with CorridorKey 2.0, Corridor Digital's AI keyer, on your own graphics card.

## Getting started

1. The first time, CorridorKey opens its **setup**: three steps, each ticked when done. Download the GPU runtime and the CorridorKey models (a 4.86 GB download on Linux, 4.64 GB on Windows, 3.32 GB on macOS, once), install ffmpeg if it's missing (the app offers to), and add your first clip. The engine itself comes with the app. **Engine → Open the setup** brings it back.
2. Open **Queue** and drop clips, frame folders or a folder of clips anywhere on the window, or use **Add clips**.
3. Pick a clip; its settings are in the panel on the right. Press **Start queue**.

## The rail

The rail on the right takes you to the pages. Hover it for names, or press **Ctrl+B** to keep it open. The lock in its bottom corner keeps it icons-only. Pressing the page you're on shows or hides its settings panel. A yellow dot on an icon means something is waiting there; pressing it takes you to it.

## Hints

- **No hint:** the model decides what the subject is. Fastest to set up.
- **First-frame matte:** a matte for the first frame (white = subject). Usually the best practical choice.
- **Hint video:** a matte for every frame (a roto pass, a garbage matte, an automatic mask).

A matte named like the clip (`shot01FrameHint.png`, `shot01_AlphaHint.mp4`) is found and selected when the clip is added. **Hint trust** tells the model how far to trust your matte: 0.95 for an artist's matte, 0.75 for a rough automatic one, 0.5 or less for a loose one.

## Internal resolution

**Full** runs the networks at the clip's own size. **¾**, **½** and **¼** run them smaller (the original CorridorKey's `--model_scale`, the plugin's Internal Resolution): faster and lighter on graphics memory, and the result is resized back to the clip's size with the same Lanczos filter the original uses, so the edges carry less detail. The section shows the size the networks run at, and the Manual memory estimate follows it. What each step costs in detail and gains in speed is measured in docs/BACKLOG.md row 42.

## Linear exposure (video clips)

**Brightness** and **Contrast** (around a **pivot**, 0.18 = mid grey) adjust the scene-linear frames the networks see, the original's `--linear_brightness`, `--linear_contrast` and `--linear_contrast_pivot`; the foreground is turned back by the exact inverse, so the outputs keep the clip's own exposure. Useful for an under- or over-exposed plate. As in the original, it applies to video clips only, so frame-folder clips don't show it.

## Graphics memory

**Automatic** picks the largest temporal window that fits the graphics memory free when the job starts. Bigger windows give steadier mattes over time. While a job runs, the Queue page shows the window it really used and the free memory it saw. If another program uses the card, the page names it.

**Manual** lets you pick the window yourself (Window / stride) and Low-memory mode. Each choice shows the engine's estimate of the graphics memory it will take for the selected clip ("24 / 12 · about 11.3 GiB" for an HD clip), the Low-memory checkbox shows both modes for the window picked, and a Graphics memory line says "About X GiB of Y GiB free on this card: fits" or "doesn't fit". The number is the engine's own (the same estimate its Automatic choice uses), not the app's: opening the section starts the engine for a moment (about 0.15 s; it loads no model and takes no graphics memory) to read the clip's size and the card's free memory, then it quits. While the queue runs the engine is busy, so the line shows the last reading, marked as read before the queue started. "Doesn't fit" means the engine's safety margin isn't met: the job may still run, or may stop out of memory. The estimate comes from this engine's own measured peaks (an RTX 5080, ONNX Runtime CUDA, six sizes from 960×720 to 4096×2160, docs/BACKLOG.md row 41) plus 6 %. They were measured with the model set the app installs (onnx.4, 2026-10-26), and the estimate is never under a measured peak: usually about 6 % over (54 of 69 points at most 15 % over), more for a few small windows (up to 57 % at a 2-frame window). Windows that ran out of memory on the 16 GB card are estimated so that the Automatic choice never picks them on it. Other sizes take the next measured size up (a bound as long as memory grows with the clip's size); other cards, drivers and TensorRT were not measured, so on those it is a close guide, not a promise.

**Memory limit** (Auto, or 2 GiB up to your card's size) caps the graphics memory a clip's job may plan for. **Auto** sends no limit: the engine's budget is the memory free on the card when the job starts (plus what the engine already holds), and Automatic picks the largest window whose estimate × 1.1 + 0.3 GiB fits it. With a limit, Automatic picks within the smaller of the free memory and the limit, and the engine's CUDA memory is capped at it, so the rest of the card stays for other programs. A Manual window is never resized, so a window past the limit can run out of memory. The row shows the card's size and free memory from the same engine reading as the estimate, and the Manual estimates are weighed against the limit. Not used on the CPU, and not shown on a Mac (Core ML takes its window from the model set). App settings → Graphics memory sets the limit new clips start with.

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

## Storage

App settings → Storage lists what the app keeps on this PC, each with its size, **Open** (shows the folder in your file manager) and **Remove…**. The **cache folder** holds clip thumbnails, result stills and the TensorRT engines built for your card; each job's working files, which a low-memory job reads every frame, stay in the system's cache folder on this PC wherever the cache folder is. Under it, the sizes per clip in the queue (with its job's working files while it runs), the stills of clips no longer in the queue (pruned at start: older than 30 days or past 500 MB), and the TensorRT engines per resolution range. **Change…** picks another location: the app makes its own `corridorkey-desktop` folder there (never writing into the folder you picked itself) and asks whether to **move the files** (each file is copied, checked against the original by size and SHA-256, and only then removed from the old folder; on any error nothing is removed and the cache stays where it was) or **start fresh** (the old cache files are deleted; thumbnails and stills are made again, TensorRT engines are built again on the next TensorRT job). **Default** goes back to the system's cache folder the same way. Not while the queue or a download runs.
