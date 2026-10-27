# Graphics memory and the window

CorridorKey keys a clip in overlapping groups of frames, the **temporal window**, written as *window / stride*
(for example 24 / 12: 24 frames at a time, moving on 12 each step). Bigger windows give steadier mattes over time,
and take more graphics memory. These settings are per clip, in the **Graphics memory** section.

## Automatic (the default)

**Automatic** picks the largest window that fits the graphics memory free when the job starts. That's the right
choice for almost every clip. While a job runs, its page shows the window it really used, whether low-memory mode
was on, and the free memory it saw (**Memory used for this run**). If another program is using the card, the Queue
page names it; the automatic window is then smaller, and both programs run slower.

The choice comes from the engine's own estimate of each window's peak memory, measured on this engine and set above
every measured point. How it was measured, and its limits (other cards, drivers and TensorRT weren't measured, so
there it's a close guide, not a promise), is in the in-app guide,
[Graphics memory](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/docs/GUIDE.md#graphics-memory), and
the README, [What we got wrong](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/README.md#what-we-got-wrong-and-what-were-doing-about-it)
(item 5).

## Manual

**Manual** lets you choose the window yourself (**Window / stride**) and **Low-memory mode**. Before the job runs,
each choice shows the engine's estimate for the selected clip ("24 / 12 · about 11.3 GiB" for an HD clip), and a
**Graphics memory** line says "About X GiB of Y GiB free on this card: fits" or "doesn't fit".

To read this, opening the section starts the engine for a moment (it loads no model and takes no graphics memory)
to read the clip's size and the card's free memory, then it quits. While the queue runs, the line shows the last
reading, marked as read before the queue started.

"Doesn't fit" means the engine's safety margin isn't met: the job may still run, or it may stop out of memory. A
manual window is never resized.

## Low-memory mode

**Low-memory mode** stages the work so less is on the graphics card at once: less graphics memory, more disk, slower.
Its working files go into the system's cache folder on this PC and are read every frame; they're removed when the
job ends. Automatic switches it on by itself when a clip needs it.

## Memory limit

**Memory limit** caps the graphics memory a clip's job may plan for: **Auto**, or a limit from 2 GiB up to your
card's size.

- **Auto:** the budget is the memory free on the card when the job starts.
- **A limit:** Automatic picks a window within the smaller of the free memory and the limit, and the engine's CUDA
  memory is capped at it, so the rest of the card stays free for other programs. A manual window isn't resized, so a manual window past the limit can run out of memory.

The row shows the card's size and free memory. **App settings → Graphics memory** sets the limit new clips start
with; each clip can change it.

## Running out of memory

If the graphics card runs out of memory, here's what happens:

- **Automatic window:** if it runs out while keying, *before any frame has been written*, the engine halves the
  window (and the stride) and starts the clip again, by itself, until it fits (a few times at most). The log says
  "out of graphics memory at window A/B: retrying at C/D", and the job page shows the window it finally used.
- **Manual window:** no retry. The job stops with "The graphics card ran out of memory".
- **Anywhere else** (outside the keying windows, or after frames were written): the job stops at once with the
  cause, since a smaller window wouldn't change it.

When a job stops out of memory, the page suggests: try **Manual** memory with a smaller window and low-memory mode,
or close other programs using the graphics card. Lowering the **Internal resolution** (¾, ½, ¼) also makes a job
lighter. See [Troubleshooting](Troubleshooting#the-graphics-card-ran-out-of-memory).
