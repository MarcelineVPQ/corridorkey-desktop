# Guide

> **A community project, not made or endorsed by Corridor Digital.** The CorridorKey model is theirs; their official
> app and plugins are at [corridorkey.com](https://corridorkey.com).

CorridorKey Desktop keys green and blue screen footage with CorridorKey 2.0, Corridor Digital's AI keyer, on your own graphics card.

## Getting started

1. The first time, CorridorKey opens its **setup**: three steps, each ticked when done. Download the GPU runtime and the CorridorKey models (a 4.03 GB download on Linux, 3.81 GB on Windows, 5.74 GB on macOS, once), install ffmpeg if it's missing (the app offers to), and add your first clip. The engine itself comes with the app. **Engine → Open the setup** brings it back.
2. Open **Queue** and drop clips, frame folders or a folder of clips anywhere on the window, or use **Add clips**.
3. Pick a clip; its settings are in the panel on the right. Press **Start queue**.

## The rail

The rail on the right takes you to the pages. Hover it for names, or press **Ctrl+B** to keep it open. The lock in its bottom corner keeps it icons-only. Pressing the page you're on shows or hides its settings panel. A yellow dot on an icon means something is waiting there; pressing it takes you to it.

## Hints

- **No hint:** the model decides what the subject is. Fastest to set up.
- **First-frame matte:** a matte for the first frame (white = subject). Usually the best practical choice.
- **Hint video:** a matte for every frame (a roto pass, a garbage matte, an automatic mask).

A matte named like the clip (`shot01FrameHint.png`, `shot01_AlphaHint.mp4`) is found and selected when the clip is added. **Hint trust** tells the model how far to trust your matte: 0.95 for an artist's matte, 0.75 for a rough automatic one, 0.5 or less for a loose one.

## Frame folders

A folder of frames has its own **Frame folder** section: the frame rate (24 by default) and **Frames are scene-linear**. A folder of OpenEXR frames starts with it on (EXR plates are scene-linear by convention); PNG and JPEG frames start with it off (display-coded, read as sRGB and clipped to 0-1). The box's hint says what the frames' format gives; a change you make is that folder's alone (every new folder starts by its format). The `corridorkey` command line reads a frame folder the same way (scene-linear when its first frame is EXR, display-coded otherwise); `--linear` and `--no-linear` choose. The Queue's **Copy as command** and the farm export write the box's choice: for EXR frames `--linear` or `--no-linear`, for other frames `--linear` when it's on.

## Internal resolution

**Full** runs the networks at the clip's own size. **¾**, **½** and **¼** run them smaller (the original CorridorKey's `--model_scale`, the plugin's Internal Resolution): faster and lighter on graphics memory, and the result is resized back to the clip's size with the same Lanczos filter the original uses, so the edges carry less detail. The section shows the size the networks run at, and the Manual memory estimate follows it. What each step costs in detail and gains in speed is measured in docs/BACKLOG.md row 42.

## Input precision

**Read 10/12-bit plates at 16 bits** (off by default): off, every clip is read at 8 bits exactly as CorridorKey 2.0
reads it, byte for byte. On, 10/12-bit video and 16-bit PNG frames reach the model in full, which differs from
CorridorKey 2.0. 8-bit clips and EXR frames are the same either way.

## Linear exposure (video clips)

**Brightness** and **Contrast** (around a **pivot**, 0.18 = mid grey) adjust the scene-linear frames the networks see, the original's `--linear_brightness`, `--linear_contrast` and `--linear_contrast_pivot`; the foreground is turned back by the exact inverse, so the outputs keep the clip's own exposure. Useful for an under- or over-exposed plate. As in the original, it applies to video clips only, so frame-folder clips don't show it.

## Graphics memory

**Automatic** picks the largest temporal window that fits the graphics memory free when the job starts. Bigger windows give steadier mattes over time. While a job runs, the Queue page shows the window it really used and the free memory it saw. If another program uses the card, the page names it.

**Manual** lets you pick the window yourself (Window / stride) and Low-memory mode. Each choice shows the engine's estimate of the graphics memory it will take for the selected clip ("24 / 12 · about 11.3 GiB" for an HD clip), the Low-memory checkbox shows both modes for the window picked, and a Graphics memory line says "About X GiB of Y GiB free on this card: fits" or "doesn't fit". The number is the engine's own (the same estimate its Automatic choice uses), not the app's: opening the section starts the engine for a moment (about 0.15 s; it loads no model and takes no graphics memory) to read the clip's size and the card's free memory, then it quits. While the queue runs the engine is busy, so the line shows the last reading, marked as read before the queue started. "Doesn't fit" means the engine's safety margin isn't met: the job may still run, or may stop out of memory. The estimate comes from this engine's own measured peaks (an RTX 5080, ONNX Runtime CUDA, six sizes from 960×720 to 4096×2160, docs/BACKLOG.md row 41) plus 6 %. They were measured with the model set the app installs (onnx.4, 2026-10-26), and the estimate is never under a measured peak: usually about 6 % over (54 of 69 points at most 15 % over), more for a few small windows (up to 57 % at a 2-frame window). Windows that ran out of memory on the 16 GB card are estimated so that the Automatic choice never picks them on it. Other sizes take the next measured size up (a bound as long as memory grows with the clip's size); other cards, drivers and TensorRT were not measured, so on those it is a close guide, not a promise.

**Memory limit** (Auto, or 2 GiB up to your card's size) caps the graphics memory a clip's job may plan for. **Auto** sends no limit: the engine's budget is the memory free on the card when the job starts (plus what the engine already holds), and Automatic picks the largest window whose estimate × 1.1 + 0.3 GiB fits it. With a limit, Automatic picks within the smaller of the free memory and the limit, and the engine's CUDA memory is capped at it, so the rest of the card stays for other programs. A Manual window is never resized, so a window past the limit can run out of memory. The row shows the card's size and free memory from the same engine reading as the estimate, and the Manual estimates are weighed against the limit. Not used on the CPU, and not shown on a Mac (Core ML takes its window from the model set). App settings → Graphics memory sets the limit new clips start with.

## TensorRT

On Linux with an NVIDIA card, a clip's **TensorRT** section says what it will run on before it starts: TensorRT once its
size's range is built, CUDA until then. **Build for this clip's size** builds that range once, in the background (it
waits while the queue runs); jobs never build one themselves. The choice to use TensorRT is in Engine settings (see
Engine below); what really ran shows on the clip's page once it starts. On Windows and macOS there is no TensorRT in
this version: jobs run on CUDA, and on a Mac on Core ML.

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

## Where results go

App settings → **Results**: by default each clip's results go into a folder next to it, `out_<clip>`; **One folder…**
puts them into `out_<clip>` folders inside a folder you pick instead, and **Next to each clip** goes back. It applies
to clips added from then on. Each job writes its outputs there, with `<clip>_settings.txt` (the settings it ran with)
and `<clip>_log.txt` (its log, for failed and cancelled jobs too).

## Appearance

App settings → Appearance: **System**, **Light**, **Dark** or **Desktop** (your desktop's own colors, followed live), the accent color, and **Glass**.

## Updates

On Windows and macOS the app checks the same signed feed and shows the same "available" notice; there **Download**
opens that version's release page on GitHub in your browser and nothing is downloaded or installed by the app.

App settings → **Updates** (the Linux AppImage; other Linux copies say why they can't update themselves): the **Channel**,
**Stable** or **Development** (new features first; may have rough edges), **Check automatically** (at start and every
few hours), **Check now**, then **Download** the new version and **Restart now** (not while the queue, the Console's
corridorkey or a download runs: it says which). On the Stable channel a development build offers **Back to stable**,
which installs the newest stable release over it. The update goes in beside the running AppImage; the previous version stays there for rollback, and at start the app
removes only older AppImages (and cut-short downloads) that its updater installed itself. A copy you downloaded or put
in that folder yourself is never removed.

When there's something to do, the update also shows above every page and as a dot on App settings (a press opens
Updates): "1.0.0 Dev 2 is available, 45.3 MB" with **Download** and **Not now**, then "Downloading 1.0.0 Dev 2…" with
its progress, then "1.0.0 Dev 2 is ready: restart to use it" with **Restart now** (waiting while the queue, the
Console's corridorkey, a download, a cache move or a TensorRT build runs, and saying which) and **Not now**. **Not
now** hides that step of that version, also after a restart; the next step or a newer version shows again, and the dot
stays while the update waits for you (to download, to restart, or after a failed install). A failed install shows its
reason until you dismiss it; a check that fails on its own says so only in Updates.

## Storage

App settings → Storage lists what the app keeps on this PC, each with its size, **Open** (shows the folder in your file manager) and **Remove…** (not while the queue, the Console's corridorkey or a download runs). The **cache folder** holds clip thumbnails, result stills and the TensorRT engines built for your card; each job's working files, which a low-memory job reads every frame, stay in the system's cache folder on this PC wherever the cache folder is. Under it, the sizes per clip in the queue (with its job's working files while it runs), the stills of clips no longer in the queue (pruned at start: older than 30 days or past 500 MB), and the TensorRT engines per resolution range. **Change…** picks another location: the app makes its own `corridorkey-desktop` folder there (never writing into the folder you picked itself) and asks whether to **move the files** (each file is copied, checked against the original by size and SHA-256, and only then removed from the old folder; on any error nothing is removed and the cache stays where it was) or **start fresh** (the old cache files are deleted; thumbnails and stills are made again, TensorRT engines are built again on the next TensorRT job). **Default** goes back to the system's cache folder the same way. Not while the queue or a download runs.

## Engine

Engine settings: **Runtime and models** downloads the GPU runtime (ONNX Runtime) and the CorridorKey models, or
says they are installed. **TensorRT** (Linux, NVIDIA): **Use TensorRT (NVIDIA)** downloads what it needs (NVIDIA's
TensorRT libraries, ONNX Runtime's TensorRT part and the TensorRT models); until they are installed, jobs run on CUDA.
Each resolution range is built once, in the background, and listed there. **ffmpeg** says whether ffmpeg is
installed and offers to install it. **ONNX Runtime engine** shows the engine program, the models folder and the ONNX
Runtime library the app uses, each with the copies it found, and lets you pick another.

## Console

The **Console** (its own icon on the rail) is a command line inside the app for people who live in one: the farm CLI's
`render`, `verify`, `prepare` and `info` with the same flags, output and exit codes, plus `help`, `apropos`, `doctor`, `farm export`, `cd`, `pwd`,
`dir` / `ls`, `bookmark`, `j`, `pushd` / `popd` / `dirs`, `set` / `unset` / `echo`, `cat` / `type`, `head`, `tail`, `exrheader` (an EXR's resolution, channels, alpha, compression),
`wc`, `du`, `tree`, `time`, `jobs` / `wait` / `kill` (the Console's one running job), `watch` (a command that reads, again every N seconds in one block), `allow`, `open` (shows a folder in the file manager), `cls`, `history`, `version`, `run` (a
`.ckcmd` script of Console lines; `source` too; outside the app, `corridorkey run nightly.ckcmd` runs the same script
from cron or a farm's pre-job, never replacing files) and `sudo`. `man render` is the long page (every option in full, examples, exit status). Other shells' words get a straight answer: `exit` says the Console stays
open, `rm` that the Console never deletes files, `less` that `cat` and `tail` show a file, `export X=1` that the
variables are `set X=1` and `${X}`. Every command and flag comes
from the `corridorkey` CLI's own definitions, so the Console and the farm never differ. `help` lists the commands,
`help render` or `render ?` explains one with examples, `help -k overwrite` (or `apropos overwrite`) searches them. The
shell reflexes work: `ls -la`, `ls -lh`, `ls -tr`, `ls *.exr`, `dir /o:-d`, `cd -`; `dir` shows a frame sequence as one
row with its range and gaps, as `lsseq` does (`frame.1.exr` … `frame.120.exr` is one sequence, `frame.#.exr 1-120`;
`dir -f` lists the frames). A frame pattern is one item everywhere: `dir plates/sh010.####.exr` (or
`%04d`, `$F4`, `@@@@`) lists that sequence, `open` shows its first frame, `cd` goes to its folder, and `verify` ends
with the missing frames as ranges you can paste into `-F` (`missing frames: 1012-1015, 1040`).

**From the queue to the command line.** Every job the queue starts appears in the Console as its exact
`corridorkey render …` line, marked "from the queue" (turn it off in **Console settings → Show GUI jobs as
commands**); **Copy as command** on a clip in the Queue copies it, quoted so a terminal runs nothing hidden in a file
name (on Windows a path with `%`, `!`, `$` or a backtick has no command line: cmd.exe and PowerShell would read it, and
the Queue says so). Pasted into a terminal it runs with the app's own models and ONNX Runtime (the newest of each the
app installed; `corridorkey` says which), unless you give `--models` / `--ort`. `farm export` writes the queue's clips as farm
jobs, with their settings: `farm export openjd --queue -o ~/farm/sq01` (an OpenJD job bundle per clip), `deadline` (job
and plugin info, with the plugin), `opencue` (a submit script), `flamenco` (a job and the job type) or `shell` (shot
lists and the line that runs them); name clips instead of `--queue` for some of them. The farm writes the frames where
the queue does (`<results>/<clip>_alpha_exr/<clip>_alpha.1001.exr`), every format replaces frames already there (a farm
retries tasks), and a frame folder holding several sequences is refused. `--models` and `--ort` give the workers' paths
(else the jobs carry this computer's, and the block says so); Deadline takes `--group` (your GPU group), `--pool` and
`--priority`, and gets a Verify job after each render; Flamenco takes `--platform`. It never replaces its own job files
unless you say `sudo … --overwrite`.

**Getting around.** `bookmark sh010` names the folder you are in (`bookmark plates ~/shots/sh010/plates` another
one), and `cd @sh010` goes there from anywhere (`@sh010/plates` too, and `dir`, `open`, `pushd` and `allow` take
`@names`; Tab completes them); `bookmarks` lists them, `bookmark -d sh010` removes one; they are kept after a restart.
`j sh010` jumps to the folder you have worked in most, and lately, whose name has sh010 (`j sq01 key`: a path with
sq01 and then key; `j` alone lists them, best first), learned from the folders you typed commands in. `pushd <folder>`
goes somewhere and remembers where you were, `popd` comes back, `dirs` lists them.

**Variables.** `set shot=sh010` (and `set -p show=/mnt/show` to keep it after a restart), then `${shot}` in any line:
`dir ${show}/${shot}/plates`. Only `${name}` with braces is a variable, so `$F4`, `%04d`, `####` and `@@@@` in file
names stay as they are; inside `'…'` nothing is filled in. A value is always one word (spaces and all), never a flag
and never a pattern: `for f in ${show}/*.exr` still matches the `*` you typed, but a `*` inside the value is just a
character. A list is a value with spaces split by a loop: `set shots="sh010 sh020 sh030"`, then
`for s in ${shots[@]}; do …; done` (each word one item; `${shots}` alone stays one item).
`set` lists them, `unset shot` removes one, `echo ${shot}` prints it; `${cwd}`, `${home}`, `${date}`, `${time}` and
`${status}` (the last command's exit code) are the Console's own. The block shows the line as it ran and what you
typed.

**Scripting.** Join commands on one line with `;` (one after another), `&&` (the next only if this one worked) and
`||` (only if it didn't): `cd @sh010 && render plate.mov -o ~/renders/sh010`. Loop over shots, files or a sequence's
frames: `for s in sh010 sh020; do cd @${s}; render plate.mov -o ~/renders/${s}; done`, `for f in plates/*.exr; do …;
done` (the files that match, by name; a pattern that matches nothing runs nothing), `for f in plates/sh010.####.exr; do
…; done` (each frame). `if verify -i … -o …; then echo ok; else echo missing; fi` decides on the last exit code. `time
render …` says how long it took and the frames per second. Inside a script each command is one row (✓ or ✗, the line,
its time, its last line of output); click it or press Enter on it for the whole block, and one that fails opens on its
own. Script files (`run nightly.ckcmd`) use the same, over
several lines; a script stops at the first command that fails (not one on the left of `&&` / `||` or in an `if`),
`run --keep-going` goes on and still ends failed; a typed line goes on. Pipes go only from one of the Console's
commands that read (`dir`, `history`, `cat`…) to its own filters, `grep [-i] [-v] TERM`, `head` / `tail -n N` and
`count`: `dir | grep sh010`, `ls *.exr | count`; never to a program or the system. A line with `;`, `&&`, `||`, `for`, `if` or `time` runs as a script:
one at a time, and its commands that replace files say `sudo` and are confirmed together before anything runs (the
dialog shows each with its `${…}` filled in, where known, and the files it would replace). A
program runs at most 10 000 commands (a loop inside a loop counts them all), and Ctrl+C stops it after the command it is
in.

**Files.** `cat notes.txt` (or `type`) prints a text file, `head -n 20` and `tail -n 50 render.log` its start or end,
`wc` counts lines, words and bytes, `du` shows how much each folder takes, and `tree` (`-L 3` for deeper) draws the
folders with each frame sequence as one row. They only read; a binary file isn't printed. On a big share `du`, `tree`,
`wc` and `j` can take a while: Ctrl+C stops them.

**doctor** checks this computer in one go: the corridorkey command line, the graphics card and its driver, ONNX
Runtime, the models, TensorRT, ffmpeg, and each folder the Console writes to (there, writable, free space), one row
each with ✓, ⚠ or ✗, and under each problem what to do (a command, or where in the app). It only asks; it never keys
on the card. `doctor --json` prints the same as JSON.

**Safety.** It is not a system shell: only its own commands, each one parsed and checked (no subshells or other
programs, its pipes only into its own filters; its variables are `${name}` only, and a value is always one word, never a flag). It **reads anywhere** you can, and **writes only into the folders you chose**: the results folder
(App settings), the cache folder, the queued clips' results folders, and the folders you **allow**; anything else is
refused with the reason and the line that allows it (`allow "/mnt/show/sq01"`), before anything runs. `allow <folder>`
asks you to confirm, then the Console may write in that folder and every folder inside it, also after a restart;
`allow` alone lists them, and **App settings → Console** removes each one. A command that **replaces files** (`render … --overwrite`, and `render … --skip-existing`, which
keys the whole set again unless every frame is already there and whole) runs only as `sudo render …`: a dialog shows
the line as you typed it, the command as it runs (each word quoted) and how many files at the run's names are there
now; confirmed, the Console stays elevated for 5 minutes (each
elevated command extends it, never past 15), shown by a badge with its countdown in the bar and in **Session**,
where **Drop elevation** ends it (as does `sudo -k`, locking the screen, the computer sleeping, or quitting; switching to another window doesn't, except on a Linux desktop without systemd-logind, where the app can't see the screen lock). Elevated commands are
logged (`history --audit`); one the log can't record doesn't run. A script (`run`, or several lines you paste: the
Console offers to run them in order, Enter runs, Esc keeps the first) never uses the Console's elevation: its lines that
replace files must say `sudo`, and one dialog lists them all before anything runs. `sudo` on a line that replaces
nothing says it isn't needed. To render again without replacing anything, version the folder: `render … -o
~/renders/sh010_v###/` picks the next free version (`sh010_v004` when v001-v003 are there), so no sudo; the block says
which, and the audit log keeps it. A `--job` file runs only once the Console has read
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
| PageUp, PageDown | Move eight items in the list |
| Ctrl+Space | Open the list (on an empty line: every command) |
| Tab, Shift+Tab on an empty line | Leave the input, to the next or previous control (Esc empties the line first) |
| →, End, Ctrl+F | Take the grey suggestion |
| Alt+→, Alt+F, Ctrl+→ | Take one word of it (else a word forward) |
| ↑ ↓, Ctrl+P Ctrl+N | Earlier lines that start with what you typed |
| Ctrl+R | Search the history as you type; again for older; Enter runs; Esc or Ctrl+G cancels |
| Alt+. | Insert the last word of the line before (the output path you just used) |
| `!!` `!N` `!-N` `!abc` `!$` `^a^b` | History shortcuts, as in bash: the line before (`sudo !!`), line N of `history`, N lines back, the last line starting with abc, the last word of the line before, the line before with a changed to b; the hint shows what Enter runs. A `!` inside a name (`sh010!.mov`), in quotes or before a frame token (`!$F4`) stays as typed |
| Ctrl+A, Ctrl+E | Start, end of the line |
| Ctrl+F, Ctrl+B | A character forward, back (Ctrl+F takes the grey suggestion when there is one) |
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
block when you point at it (a `corridorkey` command's block adds **Copy as farm line**: the exact `corridorkey …` line it
ran, quoted for this computer's shell, bash or cmd, without the Console's own progress and temporary-folder flags; a
finished `render` adds **Copy as Nuke Read**, a Read node per EXR sequence it wrote) or Tab to them (always on a touch screen); the blocks of the Console's own commands (`dir`,
`pwd`, `help`…) are compact, and `cd` prints nothing when it worked (the bar and the prompt show the folder); a render's output folder and report open with **Show in folder**. A listing's sizes are human (KiB, MiB, GiB, in its summary too) and its dates
ISO-style local time (`2026-10-26 22:58`); a long name ends in … (point at it for all of it), long folders show as
`~/…/sh010/plates`, and **Copy output** copies the same columns with everything whole. `doctor` is a table with each
problem's fix under it. Elevated blocks are marked amber. The arrow at a block's start folds it to its line (and back);
**Session → Show → Failed only** shows only the commands that failed or were refused (and any still running), with a
line above the log saying so and **Show all**; Ctrl+↑ and Ctrl+↓ jump from block to block (outlined; Ctrl+↓ past the
newest is back at the input).
**History** in the panel searches every line you typed (and the folder you typed it in), with its number and ✓ or ✗;
a click puts one back. `history 20` prints the last 20, `history sh010` the lines about sh010, each with when it ran
and its exit code. Start a line with a space to keep it out of the history.

Examples:

```
cd ~/shots/sh010
bookmark sh010
cd @sh010
set -p show=/mnt/show
dir ${show}/sh010
j sh010
dir plates
dir plates/sh010.%04d.exr
allow ~/renders
render -i plates/sh010.####.exr -o ~/renders/sh010/sh010_key.####.exr -F 1001-1100 --outputs alpha,fg
sudo render sh010.mov -o ~/renders/sh010/ --overwrite
verify -i plates/sh010.####.exr -o ~/renders/sh010/sh010_key.####.exr -F 1001-1100
run nightly.ckcmd
for s in sh010 sh020; do cd @${s} && time render plate.mov -o ~/renders/${s}; done
for f in ${show}/sh010/plates/*.exr; do echo ${f}; done
set shots="sh010 sh020 sh030"
for s in ${shots[@]}; do cd @${s} && render plate.mov -o ~/renders/${s}_v###/; done
ls -lh *.exr
tree -L 2 ~/shots/sh010
farm export openjd --queue -o ~/farm/sq01
farm export deadline --queue -o ~/farm/sq01 --group gpu --models /opt/ck/models --ort /opt/ck/libonnxruntime.so
doctor
```
