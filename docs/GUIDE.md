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

## Console

The **Console** (its own icon on the rail) is a command line inside the app for people who live in one: the farm CLI's
`render`, `verify`, `prepare` and `info` with the same flags, output and exit codes, plus `help`, `apropos`, `doctor`, `farm export`, `cd`, `pwd`,
`dir` / `ls`, `bookmark`, `j`, `pushd` / `popd` / `dirs`, `allow`, `open` (shows a folder in the file manager), `cls`,
`history`, `version`, `run` (a `.ckcmd` script of Console lines) and `sudo`. Other shells' words get a straight answer: `man` is `help`, `exit` says the Console stays
open, `rm` that the Console never deletes files, `cat` and `echo` that they come later. Every command and flag comes
from the `corridorkey` CLI's own definitions, so the Console and the farm never differ. `help` lists the commands,
`help render` or `render ?` explains one with examples, `help -k overwrite` (or `apropos overwrite`) searches them. The
shell reflexes work: `ls -la`, `ls -tr`, `dir /o:-d`, `cd -`; `dir` shows a frame sequence as one row with its range
and gaps (`dir -f` lists the frames). A frame pattern is one item everywhere: `dir plates/sh010.####.exr` (or
`%04d`, `$F4`, `@@@@`) lists that sequence, `open` shows its first frame, `cd` goes to its folder, and `verify` ends
with the missing frames as ranges you can paste into `-F` (`missing frames: 1012-1015, 1040`).

**From the queue to the command line.** Every job the queue starts appears in the Console as its exact
`corridorkey render …` line, marked "from the queue" (turn it off in **Console settings → Show GUI jobs as
commands**); **Copy as command** on a clip in the Queue copies it. `farm export` writes the queue's clips as farm
jobs, with their settings: `farm export openjd --queue -o ~/farm/sq01` (an OpenJD job bundle per clip), `deadline` (job
and plugin info, with the plugin), `opencue` (a submit script), `flamenco` (a job and the job type) or `shell` (shot
lists and the line that runs them); name clips instead of `--queue` for some of them. It never replaces its files
unless you say `sudo … --overwrite`.

**Getting around.** `bookmark sh010` names the folder you are in (`bookmark plates ~/shots/sh010/plates` another
one), and `cd @sh010` goes there from anywhere (`@sh010/plates` too, and `dir`, `open`, `pushd` and `allow` take
`@names`; Tab completes them); `bookmarks` lists them, `bookmark -d sh010` removes one; they are kept after a restart.
`j sh010` jumps to the folder you have worked in most, and lately, whose name has sh010 (`j sq01 key`: a path with
sq01 and then key; `j` alone lists them, best first), learned from the folders you typed commands in. `pushd <folder>`
goes somewhere and remembers where you were, `popd` comes back, `dirs` lists them.

**doctor** checks this computer in one go: the corridorkey command line, the graphics card and its driver, ONNX
Runtime, the models, TensorRT, ffmpeg, and each folder the Console writes to (there, writable, free space), one row
each with ✓, ⚠ or ✗, and under each problem what to do (a command, or where in the app). It only asks; it never keys
on the card. `doctor --json` prints the same as JSON.

**Safety.** It is not a system shell: only its own commands, each one parsed and checked (no variables, pipes, globs
or other programs). It **reads anywhere** you can, and **writes only into the folders you chose**: the results folder
(App settings), the cache folder, the queued clips' results folders, and the folders you **allow**; anything else is
refused with the reason and the line that allows it (`allow "/mnt/show/sq01"`), before anything runs. `allow <folder>`
asks you to confirm, then the Console may write in that folder and every folder inside it, also after a restart;
`allow` alone lists them, and **App settings → Console** removes each one. A command that **replaces files** (`render … --overwrite`, and `render … --skip-existing`, which
keys the whole set again unless every frame is already there and whole) runs only as `sudo render …`: a dialog shows
the line as you typed it, the command as it runs (each word quoted) and how many files at the run's names are there
now; confirmed, the Console stays elevated for 5 minutes (each
elevated command extends it, never past 15), shown by a badge with its countdown in the bar and in **Session**,
where **Drop elevation** ends it (as does `sudo -k`, locking the screen, the computer sleeping, or quitting; switching to another window doesn't). Elevated commands are
logged (`history --audit`); one the log can't record doesn't run. A script (`run`, or several lines you paste: the
Console offers to run them in order, Enter runs, Esc keeps the first) never uses the Console's elevation: its lines that
replace files must say `sudo`, and one dialog lists them all before anything runs. `sudo` on a line that replaces
nothing says it isn't needed. A `--job` file runs only once the Console has read
and checked it, and its output and temporary folders are fixed when it starts. **Stop** (or Ctrl+C) ends a command on
every system, Windows included; quitting the app stops it too. A screen reader hears each command's start and end, not
every line it prints.

**Typing.** As you type, the line is coloured: commands, flags, paths, and mistakes underlined before you press
Enter (an unknown command or flag with its "did you mean", a value out of range; `--format EXR` is fine, and
`--device gpu` asks "did you mean auto?", the graphics card), a flag that replaces files in
amber. The line under the input explains the mistake, or the flag the cursor is on. A grey suggestion follows the
cursor: your history first (only lines that would run), then the commands; **→** takes it, **Alt+→** one word of it;
it never runs by itself. **Tab** completes commands, flags, values and paths (a frame sequence as one pattern, `sh010_plate.####.exr`, with its
frame range beside it); when several fit it adds what they
share, and a second Tab opens the list. **Console settings → Completions → List** shows the list as you type
instead (**F2** switches).

**Keys** (also in the panel's Keys section):

| Keys | What they do |
| --- | --- |
| Enter | Run the line |
| Tab | Complete; again (or when it's ambiguous) for the list |
| Tab, Shift+Tab, ↑ ↓ | Move in the list; Enter takes the item, Esc puts the line back |
| Ctrl+Space | Open the list |
| →, End, Ctrl+F | Take the grey suggestion |
| Alt+→, Alt+F | Take one word of it (else a word forward) |
| ↑ ↓, Ctrl+P Ctrl+N | Earlier lines that start with what you typed |
| Ctrl+R | Search the history as you type; again for older; Enter runs; Esc or Ctrl+G cancels |
| Alt+. | Insert the last word of the line before (the output path you just used) |
| `!!` `!N` `!-N` `!abc` `!$` `^a^b` | History shortcuts, as in bash: the line before (`sudo !!`), line N of `history`, N lines back, the last line starting with abc, the last word of the line before, the line before with a changed to b; the hint shows what Enter runs. A `!` inside a name (`sh010!.mov`), in quotes or before a frame token (`!$F4`) stays as typed |
| Ctrl+A, Ctrl+E | Start, end of the line |
| Alt+B, Alt+← | A word back (Option on a Mac, Option+F a word forward) |
| Ctrl+U, Ctrl+K, Ctrl+W, Alt+D | Cut to the start, to the end, the word before, the word after |
| Ctrl+Y | Paste back what was cut last |
| Ctrl+D | Delete the character under the cursor; on an empty line nothing (the Console never closes) |
| Ctrl+C | Copy the selection; else stop the running command (again: at once); else clear the line |
| Ctrl+L, Cmd+K | Clear the screen (`cls` too); a running command's block stays |
| F2 | Completions inline or as a list |

**Output.** Each command is a block: the line, its state (running, done, failed, refused, stopped), the exit code
and what it means, the CLI's progress (frames handed to the writers) and phase, and what it printed. **Copy
command**, **Copy output** and **Re-run** (puts the line back in the input to edit; it never runs by itself) show on a
block when you point at it or Tab to them (always on a touch screen); the blocks of the Console's own commands (`dir`,
`pwd`, `help`…) are compact, and `cd` prints nothing when it worked (the bar and the prompt show the folder); a render's output folder and report open with **Show in folder**. A listing's sizes are human (KiB, MiB, GiB, in its summary too) and its dates
ISO-style local time (`2026-10-26 22:58`); **Copy output** copies the same columns. Elevated blocks are marked amber.
**History** in the panel searches every line you typed (and the folder you typed it in), with its number and ✓ or ✗;
a click puts one back. `history 20` prints the last 20, `history sh010` the lines about sh010, each with when it ran
and its exit code. Start a line with a space to keep it out of the history.

Examples:

```
cd ~/shots/sh010
bookmark sh010
cd @sh010
j sh010
dir plates
dir plates/sh010.%04d.exr
allow ~/renders
render -i plates/sh010.####.exr -o ~/renders/sh010/sh010_key.####.exr -F 1001-1100 --outputs alpha,fg
sudo render sh010.mov -o ~/renders/sh010/ --overwrite
verify -i plates/sh010.####.exr -o ~/renders/sh010/sh010_key.####.exr -F 1001-1100
run nightly.ckcmd
farm export openjd --queue -o ~/farm/sq01
doctor
```
