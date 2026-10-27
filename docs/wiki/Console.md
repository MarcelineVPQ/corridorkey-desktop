# Console

> **In the next development build, 1.0.0-dev.2.** 1.0.0-dev.1 doesn't have the Console.

The **Console** (its own icon on the rail) is a command line inside the app for people who live in one. It runs the
[command line](Command-Line)'s `render`, `verify`, `prepare` and `info` with the same flags, output and exit codes as
on a farm, plus its own commands to get around, look at files, script and check the machine. Every command and flag
comes from the `corridorkey` command line's own definitions, so the Console and the farm never differ.

**It is not a system shell.** It runs only its own commands, each one parsed and checked before it runs: no
subshells, no other programs, nothing passed to the system's shell. Its pipes go from one of its own commands to its
own filters (`dir | grep sh010 | count`), never to a program.

**Contents:** [Getting started](#getting-started) · [Safety](#safety) · [Commands](#commands) ·
[Frame sequences](#frame-sequences) · [Getting around](#getting-around) · [Variables](#variables) ·
[Scripting](#scripting) · [doctor](#doctor) · [Farm export](#farm-export) ·
[From the queue to the command line](#from-the-queue-to-the-command-line) · [The blocks](#the-blocks) ·
[Typing and keys](#typing-and-keys) ·
[Examples](#examples)

## Getting started

```
help                      the commands
help render               one command's options and examples (also: render ?)
help -k overwrite         search the help (also: apropos overwrite)
doctor                    is this computer ready to key?
cd ~/shots/sh010
ls *.exr
render plate.####.exr -o ~/renders/sh010 --linear
```

`render`, `verify`, `prepare` and `info` can be typed with or without `corridorkey` in front. The Console uses the
Engine page's models and ONNX Runtime. `render` and `prepare` use the graphics card: they wait for the queue (and
the queue waits for them). A render's block shows its frames, percent and the measured rate ("3.1 frames/s over the
last 20 frames", from the command line's own progress; no estimated time). One Console command runs at a time; **Stop** or Ctrl+C stops it (a render stops cleanly
after the frame it is on, exit 143).

## Safety

**Read anywhere, write only where you chose.** The Console reads wherever you can (inputs, hints, `ls`, `cd`, Tab
completion, scripts). It writes only into the results folder (App settings), the cache folder, the queued clips'
results folders, and folders you **allow**. A command that would write anywhere else is refused before anything
runs, with the reason and the line that allows it:

```
allow "/mnt/show/sq01"
```

`allow <folder>` asks you to confirm, then the Console may write in that folder and every folder inside it, also
after a restart. `allow` alone lists them; **App settings → Console** removes each one (`trust` is the same command).
`allow` never takes `/`, a drive's root or a system folder (`/etc`, `/usr`, `C:\Windows`, `C:\Program Files`…, also
through a link); allow a show or shot folder instead. Allowing your whole home folder (`allow ~`) asks with a warning:
it lets the Console replace files anywhere in your home folder.

**Network servers on Windows.** Windows sends your sign-in to every server it opens, so the Console opens a network
path (`\\nas\show\…`) only after you name its server once: `allow-server nas`. It lasts until the app quits and is
never saved; **Session** lists the servers allowed, and `allow-server` alone too. Until then a command that would
open one is refused with the line to type.

**Replacing files needs `sudo`.** A command that replaces files, `render … --overwrite`, and `render …
--skip-existing` (which keys the whole set again unless every frame is already there and whole), runs only as
`sudo render …`. A dialog shows the line as you typed it, the command as it will run, and how many files at the run's
names are there now. Confirmed, the Console stays elevated for 5 minutes (each elevated command extends it, never past
15), with a badge and its countdown in the bar and in **Session**. It ends with **Drop elevation**, `sudo -k`, locking
the screen, the computer sleeping, or quitting. Switching to another window doesn't end it (Alt+Tab to your
compositor and back), except on a Linux desktop without systemd-logind, where the app can't see the screen lock and
leaving the window ends it instead. `sudo` on a line that replaces nothing says it isn't needed.

**Render again without replacing anything:** version the folder. `-o ~/renders/sh010_v###/` picks the next free
version (`sh010_v004` when v001-v003 are there), so no `sudo` is needed; the block says which version it took.

**A log of what was elevated.** Every elevation (granted, refused, dropped), every elevated command with its targets
and exit code, every folder allowed or removed and every next free version is logged; `history --audit` shows it. A
command the log can't record doesn't run. The Console never deletes files (`rm` says so).

**Scripts never borrow your elevation.** In a script (`run`, or several lines pasted at once), the lines that replace
files must say `sudo`, and one dialog lists them all, with their `${…}` filled in where known, before anything runs.

## Commands

| Command | What it does |
| --- | --- |
| `render`, `verify`, `prepare`, `info` | the [command line](Command-Line)'s commands (also with `corridorkey` in front); `corridorkey --version` too |
| `help [command]`, `help -k <term>` | the commands, one command's options and examples, or a search (`render ?` too) |
| `man <command>` | a command's manual page: every option in full (its values, limits, what it writes, what it can't go with), examples, exit status |
| `apropos <term>` | search the commands and their options |
| `doctor` | check this computer in one go, each problem with its fix ([below](#doctor)) |
| `farm export <format>` | write the queue's clips as render farm jobs ([below](#farm-export)) |
| `cd [folder]`, `pwd` | change or print the current folder (`cd -`: the one before; `cd` alone: your home folder) |
| `dir` / `ls [folder or pattern]` | list files with sizes and dates; a frame sequence is one row ([below](#frame-sequences)) |
| `bookmark <name> [folder]`, `bookmarks` | name a folder; `cd @name` goes there ([below](#getting-around)) |
| `j <part…>` | jump to the folder you use most and lately whose path has these parts (alias `z`) |
| `pushd`, `popd`, `dirs` | go somewhere and come back |
| `set`, `unset`, `echo` | variables ([below](#variables)) |
| `cat` / `type`, `head`, `tail` | print a text file, its start or its end (`-n N`); a binary file isn't printed |
| `exrheader <file or pattern>` | an EXR's header: resolution, data window, channels (alpha or not), pixel type, compression; a sequence's first frame |
| `wc` | count a text file's lines, words and bytes |
| `grep`, `count` | after a `\|`: keep the lines or rows with a word; how many there are ([below](#scripting)) |
| `du [folder…]` | how much each folder takes on disk |
| `tree [folder] [-L N] [-a]` | the folders as a tree, a frame sequence as one row |
| `watch [-n S] <command>` | run a command that reads (`dir`, `du`, `verify`…) again every S seconds (default 10) in one block; Ctrl+C stops it |
| `time <command>` | run a command and say how long it took (a render's frames per second too) |
| `run [--keep-going] <file.ckcmd>` | run a script ([below](#scripting)); `source` is the same command |
| `history [N or term]` | the lines typed before, numbered, with when and how each ended; `history --audit` the elevation log |
| `allow [folder]` | let the Console write in a folder ([above](#safety)) |
| `allow-server [server]` | Windows: let the Console open a network server's paths until the app quits ([above](#safety)) |
| `open [path]` | show a folder or file in the file manager (as Show in folder does: it never opens or runs a file; `start` too) |
| `sudo <command>`, `sudo -k` | run a command that replaces files, after you confirm it; drop the elevation |
| `version` | the app's version, which is its command line's |
| `cls` / `clear` | clear the screen (Ctrl+L too) |

Other shells' words get a straight answer instead of "unknown command": `exit` says the Console stays open, `rm` that
it never deletes files, `cp` / `mv` that `render -o` writes where you say, `less` that `cat` and `tail` show a file,
`export X=1` (or `X=1`, `setenv`, `$env:X=`) that the Console's variables are `set X=1` and `${X}`, `lsseq` that `dir`
shows sequences. `echo $HOME` prints `$HOME` and says that only `${name}` expands. An unquoted `?` anywhere on a line
asks for help, so a file named `?` goes in quotes (the help says so when it sees other arguments).

## Frame sequences

The Console reads folders as a compositor does. `ls` shows a frame sequence as one row, with its range and gaps:

```
sh010_plate.####.exr  1001-1100 · 96/100 frames
```

A sequence with gaps shows how many frames are there out of its range; hover the row for the missing ones (**Copy
output** has them too). `ls -f` lists every frame. Houdini's pre-roll, `sim.-010.exr` … `sim.-001.exr`, is part of
`sim.####.exr`, and the row says how many frames are below 0 (`corridorkey`'s patterns and `-F` start at 0). Unpadded runs (`frame.1` … `frame.120`, shown `frame.#.exr 1-120`) and runs that outgrow
their padding (`sim.9999`, `sim.10000`) are one sequence. A frame pattern, `plate.####.exr`, `plate.%04d.exr`,
`plate.$F4.exr` or `plate.@@@@.exr` (one digit per `@`), is one item everywhere: `ls plates/sh010.####.exr` lists that
sequence, `open` shows its first frame, `cd` goes to its folder. Tab completes a sequence as one pattern. `verify` ends
with the missing frames as ranges you can paste into `-F` (`missing frames: 1012-1015, 1040`), and its block offers
**Re-render missing**: it puts `render` with the same flags and `-F 1012-1015,1040` in the input for you to check and
run (`sudo … --overwrite` when a listed frame is there but not whole: only those frames are replaced). It never runs
by itself.

`exrheader plates/sh010.####.exr` answers the first question about a plate, is it the 4K one and does it have alpha,
from its first frame's header (resolution, data window, channels and their pixel type, compression, line order;
each part of a multi-part file), without leaving for OpenEXR's `exrheader`.

The listing flags you know work: `ls -la`, `ls -lh`, `ls -tr`, `ls -S`, `ls -1`, `ls *.exr`, `dir /o:-d`, `dir /b`.

## Getting around

```
bookmark sh010                         name the folder you are in
bookmark plates ~/shots/sh010/plates   name another one
cd @sh010                              go there from anywhere (@sh010/plates too)
bookmarks                              list them
bookmark -d sh010                      remove one
j sh010                                the folder you've worked in most, and lately, with sh010 in its name
j sq01 key                             a path with sq01 and then key
pushd ~/renders                        go there, remembering where you were
popd                                   come back
dirs                                   the folders pushd remembered
```

`dir`, `open`, `pushd` and `allow` take `@names` too, and Tab completes them. Inside a bookmarked folder the prompt
starts with its name, `@sh010/key ❯` (deeper: `@sh010/…/key`); elsewhere it shows the last two folders, `comp/key ❯`. Bookmarks are kept after a restart;
`j` learns from the folders you typed commands in.

## Variables

```
set shot=sh010                     this session
set -p show=/mnt/show              kept after a restart
dir ${show}/${shot}/plates
echo ${shot} ${date}
unset shot
set                                list them
```

Only `${name}`, with braces, is a variable, so `$F4`, `%04d`, `####` and `@@@@` in file names stay as they are; inside
`'…'` nothing is filled in. A value is always one word (spaces and all), never a flag and never a pattern:
`for f in ${show}/*.exr` matches the `*` you typed, but a `*` inside the value is just a character. A list is a value
split by a loop: `set shots="sh010 sh020 sh030"`, then `for s in ${shots[@]}; do …; done`.

The Console's own (read-only): `${cwd}`, `${home}`, `${date}` (YYYY-MM-DD), `${time}` (HH-MM-SS, safe in file names)
and `${status}` (the last command's exit code). The block shows the line as it ran, and what you typed.

## Scripting

A small language, not a shell: `;` (one after another), `&&` (the next only if this one worked), `||` (only if it
didn't), `for NAME in WORDS; do …; done`, `if …; then …; else …; fi`, `time`, and pipes into the Console's own
filters. No redirections, subshells or background jobs, and nothing ever goes to a program or the system.

**Pipes.** A listing or a command's printed lines go through `grep [-i] [-v] TERM` (keep what contains TERM; `-i` any
case, `-v` what doesn't), `head` / `tail [-n N]` (the first or last N) and `count` (how many; last). A listing stays a
listing, filtered by name, with how many rows came through:

```
dir | grep sh010
ls *.exr | count
ls -t | head -n 5
history | grep -i render | tail -n 3
cat notes.txt | grep -v draft
```

What goes in is a command of the Console's that only reads: `dir`, `history`, `cat`, `head`, `tail`, `exrheader`,
`tree`, `du`, `wc`, `help`, `man`, `apropos`, `echo`, `version`, `bookmarks`, `dirs`, `jobs` and the lists of `j`,
`set` and `allow`. A render, a script or anything that changes something never goes into a pipe.

```
cd @sh010 && render plate.mov -o ~/renders/sh010
for s in sh010 sh020; do cd @${s}; render plate.mov -o ~/renders/${s}; done
for f in plates/*.exr; do echo ${f}; done
if verify -i plates/sh010.####.exr -o key/sh010.####.exr; then echo ok; else echo missing; fi
time render shot.mov -o ~/renders/sh010
```

`for` over `plates/*.exr` is the files that match (a pattern that matches nothing is an error, not the pattern
itself); over `plates/sh010.####.exr` it is each frame. Inside a program each command is one row (✓ or ✗, the line,
its time, its last line of output): click it, or press Enter on it, for the whole block; one that fails opens by
itself.

**Script files** (`.ckcmd`) hold the same, over several lines; `#` starts a comment. `run nightly.ckcmd` stops at the
first command that fails (not one on the left of `&&` / `||` or in an `if`'s condition) and says the line;
`run --keep-going nightly.ckcmd` goes on and still ends failed. A typed line goes on after a failure, as bash does.
Pasting several lines offers them as a script (Enter runs them in order, Esc keeps the first line). A program runs at
most 10 000 commands, and Ctrl+C stops it after the command it is in.

## doctor

`doctor` checks this computer in one go, one row each with ✓, ⚠ or ✗, and under each problem what to do (a command,
or where in the app):

- the `corridorkey` command line;
- the graphics card and its driver, ONNX Runtime and the models (from `corridorkey info`: it loads the runtime and asks
  the driver, never keys, so it runs while the queue does);
- TensorRT (off; on but not downloaded; on, and how many size ranges are built);
- ffmpeg (ffmpeg, ffprobe and the encoders the outputs need);
- each folder the Console writes to: there, writable, and its free space (✗ under 2 GiB, ⚠ under 20 GiB).

It ends failed (exit 1) when a row is ✗, so a script can stop on it. `doctor --json` prints the same as JSON.

## Farm export

`farm export <openjd|deadline|opencue|flamenco|shell>` writes clips in the queue as ready-to-submit farm jobs, with
the settings each has in the queue. Name clips (by path or file name) or say `--queue` for all of them; `-o` is the
folder the job files go in.

```
farm export openjd --queue -o ~/farm/sq01 --models /opt/ck/models --ort /opt/ck/libonnxruntime.so
farm export deadline sh010.mov -o ~/farm/sh010 --group gpu --pool show --priority 60
farm export opencue --queue -o ~/farm/sq01
farm export flamenco --queue -o ~/farm/sq01 --platform windows
farm export shell --queue -o ~/farm
```

What each format writes, and how to submit it: [Render farm](Render-Farm#from-the-app-farm-export). The frames land
where the queue puts them, every format replaces frames already there (a farm retries tasks), and the block lists
notes for the wrangler (this computer's paths when you gave no `--models` / `--ort`, a Deadline job without a GPU
group, a clip left out and why), and each clip's submit line, ready to paste (`deadlinecommand …` with its job files'
full paths, `deadline bundle submit …`, `CUE_SHOW=<show> sh …`, `curl … <manager>/api/v3/jobs …`: fill in what is in
`<…>`). It never replaces its own job files unless you say `sudo farm export … --overwrite`.

## From the queue to the command line

Every job the queue starts appears in the Console as its exact `corridorkey render …` line, marked "from the queue"
(**Console settings → Show GUI jobs as commands** turns it off). **Copy as command** on a clip in the Queue copies
the same line, quoted so a terminal runs nothing hidden in a file name. Any `render`, `verify`, `prepare` or `info`
block has **Copy as farm line**: the exact `corridorkey …` line the Console ran (paths as it resolved them, relative ones
from its folder), quoted for this computer's shell, without the Console's own progress and temporary-folder flags. A `render` that
finished adds **Copy as Nuke Read**: a `Read` node for each EXR sequence it wrote (`…%04d.exr`, its first and last
frame there), ready to paste into Nuke's node graph. Pasted into a terminal it uses the app's own
models and ONNX Runtime ([Command line: the runtime](Command-Line#the-runtime)). On Windows a path with `%`, `!`, `$`,
a backtick or `"` gets no line (cmd.exe and PowerShell would read them inside quotes), and the Queue says so.

## The blocks

Each command is a block: its line, how it ended (with the exit code and what it means) and what it printed. The arrow
at its start folds it to its line, and back. **Session → Show → Failed only** shows only the commands that failed or
were refused (and any still running); a line above the log says so, with **Show all**.

## Typing and keys

As you type, the line is coloured: commands, flags, paths, and mistakes underlined before you press Enter (an unknown
command or flag with its "did you mean", a value out of range), a flag that replaces files in amber. The line under
the input explains the mistake, or the flag the cursor is on. A grey suggestion follows the cursor (your history
first, then the commands); it never runs by itself.

| Keys | What they do |
| --- | --- |
| Enter | Run the line |
| Tab | Complete commands, flags, values, paths and `@bookmarks` (after `cd`, `pushd`, `allow`, `du`, `tree`: folders only); again (or when it's ambiguous) for the list |
| Ctrl+Space | Open the list |
| →, End, Ctrl+F | Take the grey suggestion; Alt+→ (Alt+F) one word of it |
| ↑ ↓, Ctrl+P Ctrl+N | Earlier lines that start with what you typed |
| Ctrl+R | Search the history; again for older; Esc or Ctrl+G cancels |
| Alt+. | Insert the last word of the line before |
| `!!` `!N` `!-N` `!abc` `!$` `^a^b` | History shortcuts, as in bash (`sudo !!` too); the hint shows what Enter runs. A `!` inside a name (`sh010!.mov`) or before a frame token (`!$F4`) stays as typed |
| Ctrl+C | Copy the selection; else stop the running command (again: at once); else clear the line |
| Esc | Clear the line (Ctrl+Y brings it back) |
| Ctrl+↑, Ctrl+↓ | Jump to the block before or after (outlined; past the newest: back to the input) |
| Ctrl+L, Cmd+K | Clear the screen (`cls` too) |
| F2 | Switch completions between Tab and a list as you type (**Console settings → Completions**) |

The panel's **Keys** section lists every key, the readline ones included (Ctrl+A, Ctrl+E, Ctrl+W, Ctrl+U, Ctrl+K,
Ctrl+Y, Alt+D, Alt+B; Option on a Mac). The history keeps the newest 5000 lines across restarts; a line typed with a
leading space isn't kept.

A screen reader hears each command's start and end, not every line it prints.

## Examples

```
# key every shot of a sequence, each into the next free version
for s in sh010 sh020 sh030; do cd @${s} && render plate.####.exr -o ~/renders/${s}_v###/ --linear; done

# check a render and re-render only what's missing (Re-render missing on the verify block types the second line)
verify -i plates/sh010.####.exr -o key/sh010.####.exr
render --input plates/sh010.####.exr --output key/sh010.####.exr --frames 1012-1015,1040

# a nightly script that stops at the first failure
run nightly.ckcmd

# watch a render folder fill up, or a farm's frames arrive
watch -n 30 verify -i plates/sh010.####.exr -o key/sh010.####.exr

# what took the disk
du ~/renders

# is everything ready?
doctor
```
