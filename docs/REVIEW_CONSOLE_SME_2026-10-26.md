# Console: subject-matter review (power users, VFX pipeline), 2026-10-26

Reviewer's angle: 40 years of command lines (COMMAND.COM, sh/bash/zsh/fish, PowerShell/PSReadLine, readline,
Houdini's Textport/hscript, Maya's command line) and a pipeline TD's eye (farms, Nuke/Resolve, EXR sequences).
The question is whether it *feels right* to a lighting TD, a comp lead or a colourist, not whether the code is correct.

Read: docs/CONSOLE.md, docs/GUIDE.md "Console", docs/CLI.md, `src/shared/console/` (parse.ts, registry.ts),
`electron/main/console/`, `src/ui/console/`, `src/ui/pages/ConsolePage.tsx`, `engine-rs/crates/ck-cli/src/args.rs`.
Tried in an isolated copy (`tools/isolated.sh`, CPU only, no corridorkey binary in this build, so the farm commands
stop at "isn't part of this copy"; the sudo flow was judged from the code). Earlier reviews and plans not read.

## Verdict

**Grade: B now; A- once the five MUSTs are in.** The filmic elite would *try* it on day one and respect it: the CLI
underneath is genuinely farm-grade (Nuke's `-F`, Blender's `-s`/`-e`, `####` / `%04d` / `$F4`, OpenJD and Deadline
progress, meaningful exit codes, atomic output), and the Console is one parser and one registry with that CLI, so
what you type here is what you put on the farm. Highlighting, did-you-mean, fish-style suggestions, prefix-history on
↑, Ctrl+R and Warp-style blocks with exit meanings are better than most DCC consoles ever got.

What stops adoption is not the code but three reflexes it fights: **writing the key into the show tree** (refused,
with no way to say yes from where you are), **the look-dev loop** (re-render with `--overwrite` → sudo dialog again
after every Alt+Tab to Nuke), and **sequences** (the tool's own input is a frame pattern, yet `dir` and Tab see
frames one by one). Fix those and the shell muscle-memory gaps (`ls -l`, `find`) and a comp lead keeps it open all day.

Counts: **5 MUST, 12 SHOULD, 9 NICE.**

## Findings

### MUST (before release)

**M1. The write scope is a dead end for the show tree.**
Where: `paths.ts checkWrite`, `index.ts writeRoots` (results folder, cache, queued clips' folders).
What a TD hits: `render plates/sh010.####.exr -o /mnt/show/sq01/sh010/comp/elements/key/v003/key.####.exr` is
refused: "…is outside the folders the Console may write to: … (the results folder, the cache folder, the queued
clips' results folders)". Pipelines write next to the shot, per shot and per version; one results folder in App
settings can't be that. The message says *why* but not *what to type*, and nothing in the Console can add a folder.
Fix: keep read-anywhere/write-chosen (it is right), but make "choose" one step from the refusal: a built-in
`allow <folder>` (alias `trust`) with a native confirmation, persisted, listed (and removable) in App settings and
`allow` alone; a show root (`/mnt/show`) covers every shot under it. The refusal ends with the exact line:
`allow /mnt/show/sq01/sh010` (or "choose it in App settings → …"). Optionally log grants in the audit log.

**M2. Elevation drops when the window loses focus, which breaks the look-dev loop it exists for.**
Where: `dropElevation("…blur…")` via the window's blur (docs/CONSOLE.md "Elevation").
What a comp lead hits: key → Alt+Tab to Nuke/RV to judge the edge → back → tweak `--despill 0.4` → `sudo render …
--overwrite` → dialog again. Every iteration. Real sudo keeps its timestamp across terminal focus for exactly this
reason; sv_cheats doesn't reset when you tab out. Five minutes / fifteen-minute cap already bound it.
Fix: don't drop on blur. Drop on screen lock / suspend (`powerMonitor` `lock-screen`, `suspend`), on quit, on
`sudo -k`, and at the TTL. If blur must count, drop only after the window has been away longer than the TTL left.

**M3. `ls -l`, `ls -la`, `dir /w`, `cd -` fail in the first ten seconds.**
Where: `registry.ts` BUILTINS (`dir` has only a folder argument; `cd` treats `-` as a folder).
Seen: `ls -la` → "dir has no option -l"; `dir /w` → "Can't list /w: ENOENT…"; `cd -` → "Can't go to -: ENOENT: no
such file or directory, stat '…/plates/-'". These are reflexes, not choices; a power user's first impression is
"it doesn't know `ls`".
Fix (small): `dir`/`ls` accept the common display flags and do something visible with each: `-l` (the default
table anyway), `-a` (show dot files; hidden today), `-h` (sizes are already human), `-t` / `-S` / `-r` (sort by
time / size / reverse), `-1` (names only); on Windows `/w`, `/b`, `/a`, `/o:d`. `cd -` goes to the previous folder
(and prints it, as bash does).

**M4. Sequences are invisible to Tab, the most-typed argument.**
Where: `complete.ts paths()`.
Seen: `render sh010_pl` Tab → `sh010_plate.10`, Tab again → a list of every frame (capped at 200; a plate folder
has thousands). `render`'s input wants `sh010_plate.####.exr` and the TD has to type the hashes by hand.
Fix: group numbered files into one candidate per sequence, `sh010_plate.####.exr  1001-1012 (12)`, padding from the
names, listed before (or instead of) its frames; for `-o` offer the same pattern style. Same grouping in M5's `dir`.

**M5. `find` means "find files" to every Unix and DOS user; decide the name before scripts and history fix it.**
Where: `registry.ts` `find` ("search the commands and their options").
What a TD hits: `find . -name "*.exr"` → help search for ". -name *.exr". Phase 4 plans `tree`/`du`/globbing, which
will want a file `find`; renaming after release breaks `.ckcmd` scripts and history.
Fix: `help -k <term>` (man -k) with `apropos` as the alias; keep `find` free for files (or make bare `find` print
"looking for a command? help -k …").

### SHOULD

**S1. Sequence-aware `dir`.** `dir` lists 100 000 frames one per row (5000 shown). A TD reads folders as
sequences: `sh010_plate.####.exr  1001-1100  100 frames  1.2 GiB  (missing 1047, 1050-1052)`. Group by default,
`dir -f` (or `--frames`) for the frames. This is `lsseq`, and it is the single thing that makes it feel like a VFX
tool rather than a file browser. (`dir.ts` → `runner.ts dir`; `OutputBlock` table.)

**S2. Multi-line paste is silently joined into one line.** Pasting three lines from a wiki gives
`dir cd .. pwd` (tried). Fix: on a paste with newlines, say "3 lines pasted: Enter runs them in order (as a script),
Esc keeps the first"; never join them. (`LineEditor` `onPaste`.)

**S3. The Console doesn't know the CLI's conflicts.** `render -F 1001-1100 -s 1001` is coloured clean (hint shows
`--start`'s help), then exits 2. Same for `-q -v` and `--overwrite --skip-existing`. Export `conflicts_with` in
`corridorkey __spec` and check it in `parse.ts`, so the line is underlined before Enter like every other mistake.

**S4. Errors that say what to type, everywhere.** Built-ins show Node's raw text: "ENOENT: no such file or
directory, stat '…'", "scandir '/w'". Translate: "No folder /w here", "cd -: …". And the help/hint could add the
fix: "dir has no option -l; dir already shows sizes and dates (dir -t sorts by time)".

**S5. Known foreign commands get a tailored answer, not "unknown command".** `exit`, `quit`, `man`, `echo`,
`cat`, `type`, `rm`/`del`, `cp`/`copy`, `mv`, `which`, `open`/`start`: a small table: `man x` = `help x`; `exit` =
"the Console stays open; Ctrl+L clears, the rail leaves"; `rm` = "the Console never deletes files"; `open .` /
`start .` = show the folder in the file manager (there's already Show in folder). Cheap, and it's what makes a
shell feel *aware* of you.

**S6. `history` takes no arguments.** `history 10` is refused. Accept `history [N]` and `history <term>`, number
the lines stably (for `!N` in Phase 4), and skip lines typed with a leading space (bash/zsh `ignorespace`, for a
line you don't want kept). Store the folder, time and exit code with each line (atuin-style) so "what did I run for
sh010 last week, and did it pass?" has an answer; show the exit as ✓/✗ in the History panel.

**S7. `--version` and `version`.** `corridorkey --version` → "has no command '--version'"; `render --version` too.
That is the first thing a wrangler types on a new box. Map both (and `version`) to the CLI's version, or to
`info` with a one-line form.

**S8. Dates and sizes for pros.** `dir` shows "10/26/26, 10:58 PM" (US short, no seconds, ambiguous 26/26), and the
summary prints raw bytes ("12 files (0 bytes)"; a plate folder reads "1288490188800 bytes"). Use ISO-style local
time `2026-10-26 22:58:04` (sortable, unambiguous across studios), human size in the summary, and in **Copy output**
keep the same columns as the table (today it copies raw bytes and no dates).

**S9. The blocks are loud.** Every block, even `pwd`, carries three always-visible buttons (Copy command, Copy
output, Re-run) and `cd` prints the full path. In a session of 40 commands the chrome outweighs the output. Show the
actions on hover/focus (keyboard-reachable), make `cd` silent on success (the bar and prompt already show it), and
let built-in blocks render compact.

**S10. Readline's missing reflexes.** **Alt+.** (insert the last word of the previous line: the output path you
just used; extremely common), Ctrl+Y (yank what Ctrl+U/K/W cut; today the cut text is gone), Alt+D (delete word
forward), Ctrl+P/Ctrl+N (history), Ctrl+D on an empty line (ignore or explain, never close). On macOS Option+F/B
type `ƒ`/`∫` (backlog 113: read `e.code`), and Cmd+K should clear like Terminal/iTerm.

**S11. Scripts and elevation.** `run` inherits an active elevation (backlog 110). Agree with fixing it, and the
pipeline-native shape is: a script states it up front (`# sudo` on its first line, or `sudo run x.ckcmd`), and one
dialog lists all its destructive lines; never per-line dialogs in a script, never silent inheritance. Also: `sudo`
on a line that needs none should say so (backlog 107), and the hint shouldn't say "(needs sudo)" when `sudo` is
already on the line.

**S12. Did-you-mean should know synonyms.** `--device gpu` → "did you mean cpu?" (edit distance, wrong meaning:
gpu means cuda/auto). `--format EXR` is refused for case. Accept enum values case-insensitively (the CLI can
lowercase too) and add a synonyms table (gpu→cuda, nvidia→cuda, mac/metal→coreml, mp4/mov→video).

### NICE

- **N1.** `cd` completion offers files too; offer folders only (and `cd` into a sequence's folder from `-i`'s value).
- **N2.** Progress shows frames and %, no rate. A measured rate ("3.1 frames/s over the last 20") is real data
  (rule 1); an ETA, if ever, labelled as an estimate.
- **N3.** Esc on the line: PSReadLine users expect it to clear the line (today it may close the panel).
- **N4.** `source` as an alias of `run` (bash, Maya, hscript all say `source`).
- **N5.** An unquoted `?` anywhere is help; a filename with `?` needs quoting. Fine, but say so in the error.
- **N6.** `verify` (exit 9) should print missing frames as ranges ("missing 1047, 1050-1052"), the way a
  wrangler pastes them into a requeue (`-F 1047,1050-1052`); offer "Re-run these frames" on the block.
- **N7.** A block's **Copy as farm line**: the exact `corridorkey …` argv the Console ran, quoted for bash or cmd,
  without the Console's own `--progress-format`/`--temp` (it's already built for the sudo dialog).
- **N8.** Blocks could be collapsed/folded and filtered (failed only), as in Warp; and Ctrl+↑/↓ to jump between
  blocks.
- **N9.** The prompt shows only the last folder; a `shot/version`-aware prompt (two parts) helps when every shot has
  `comp/key`.

## The first hour (a comp TD, Linux, show on /mnt/show)

She opens Console, types `ls -la` out of habit: refused. Shrugs, `ls` works and the table is clean. `cd
/mnt/show/sq01/sh010/plates`, Tab-completes nicely, `dir`: 1 100 rows of frames. She wanted one line. She types
`render sh010_pl` + Tab and gets `sh010_plate.10`; types the `####.exr` by hand. The line lights up as she types,
`--frames 1001-1100` hint is clear, `-o ../comp/key/v001/key.####.exr`: Enter. Refused: outside the folders the
Console may write to. She opens App settings, sets the results folder to that shot (and will have to change it for
sh020). Renders; the block's progress bar and "exit 0 done" feel great; Show in folder works.
She checks the edge in Nuke, comes back, changes `--despill 0.35`, ↑-edit, Enter: "replaces files … run it as sudo
…". Ctrl+A, `sudo `, Enter, dialog, confirmed, badge 5:00. Back to Nuke, back again, `--despill 0.3`: the dialog
again (focus dropped it). By the third time she's writing to `v002`, `v003` to avoid it, which is honestly what the
pipeline wanted anyway, but it should have been her choice. She types `find . -name "*.exr"`: it searches the help.
`history 20`: refused. She pastes three render lines from the shot's wiki page: one broken line. Then she discovers
Ctrl+R, the grey suggestions and `render ?` with examples, and `verify` with the same flags as render, and starts a
`nightly.ckcmd`. Verdict at the end of the hour: "the CLI is excellent, the Console needs to let me write where my
shots live and stop asking me twice."

## What's done well (keep it)

- **One parser, one registry, generated from the CLI's own spec**, with a drift test: the Console and the farm can't
  disagree. This is the most important design decision and it's right.
- The CLI's idioms: `-F` (Nuke), `-s`/`-e` (Blender/Deadline), `####` / `%04d` / `$F4` outputs, `--` before a clip,
  GNU `--flag=value`, `-qv` bundling, `--progress-format openjd|deadline`, documented exit codes with meanings shown
  on the block (`exit 6: out of graphics memory (try --max-vram lower…)` is exactly what a wrangler wants).
- Output safety (hidden folder, all-or-nothing renames, `.partial` frames) makes `--overwrite` far safer than in any
  renderer; the sudo dialog showing *what will be replaced and how many bytes* is a real improvement over `sudo`.
- Never a shell; read anywhere, write only where chosen; the resolved path is what runs; the audit log is
  append-only and refuses unlogged elevation. Security people will sign off on this.
- Typing: highlight-as-you-type with the mistake underlined *and* explained, did-you-mean on commands, flags and
  values, fish suggestions only from lines that would run, prefix ↑ (zsh's up-line-or-beginning-search), Ctrl+R
  with older/cancel, Tab that inserts the common part then lists (bash/zsh), F2 inline/list (PSReadLine's
  ListView), Ctrl+C that copies a selection first (Windows Terminal/PSReadLine) then stops then clears.
- Blocks with state, exit code, meaning, duration, Re-run that **never runs by itself**, Show in folder.
- Ctrl+C → SIGTERM → clean stop after the current frame, second Ctrl+C kills the group; Windows handled honestly.
- The elevated prompt turns into `#`. Nice nod.
- Checked in the isolated copy: Ctrl+W and Ctrl+R in the input neither closed nor reloaded the window (backlog 117,
  via CDP key events; a real keyboard on Windows should still be checked once).

## Phase 4: what to build first, and what to change

1. **Sequences everywhere** (before anything else): `dir` grouping (S1), Tab patterns (M4), `####`/`%04d`/`$F4`
   understood by every built-in, `verify` gaps as ranges (N6). This is the VFX identity of the Console.
2. **Teach-by-echo + farm export.** Every GUI job shows its exact `corridorkey render …` line (copyable, "Open in
   Console"); then export the queue as a Deadline job (job info + plugin info) and an OpenJD template. This is the
   feature that turns the app into the place TDs *learn* the farm CLI. Highest adoption value per line of code.
3. **History expansion and recall**: `!!`, `!$`, `!N`, `sudo !!` (the refusal message should then say
   `sudo !!`), Alt+. (S10), `history` with exit codes (S6). Cheap, constant delight.
4. **`doctor`** early: one command that checks the card, driver, models, ONNX Runtime, TensorRT ranges, write
   folders, free disk on the results and temp folders, with a fix line per problem. It is the first-hour command on
   a new workstation or farm node.
5. **Bookmarks and frecency before variables**: `cd @sh010` / `bookmark sh010`, `z sh010`-style jump, `pushd/popd`.
   Shots are the unit of work; jumping between them is most of the typing.
6. **Variables and aliases, with a syntax that can't collide with frame tokens.** `$F`, `$F4`, `$HIP`-style words,
   `%04d`, `####`, `@` and `!` inside filenames are *data* in this world. Use `${name}` only (never bare `$name`),
   reserve `$F*` as literal, and don't expand `!` inside a word or quotes (zsh/bash `!` expansion surprises people
   with filenames). Aliases: plain word → line, no arguments magic.
7. **Safe scripting**: `&&` / `||` and `for x in a b c; …` over shots or frame ranges; `run --keep-going`; exit
   status available to the next line. Keep it a small language, not a shell.
8. **`du`, `head`/`tail`/`type`** (reports, settings files, `.ckcmd`), `tree` (shallow by default, sequences
   grouped), `time` (wraps a render, prints measured fps). `open` / `start .`.
9. **Later / maybe never**: structured pipes (the blocks already are structured; filter in the UI instead),
   `watch`, `jobs` (one job at a time makes it thin), multi-line editing beyond the paste handling in S2, man pages
   as separate texts (`man` = `help` is enough).

Change in the plan: put **sequences** and **teach-by-echo** ahead of drive-the-whole-app, and design the variable
syntax around frame tokens before writing any of it.

## Screenshots (isolated copy)

`~/.cache/claude-scratch/ck-console-sme/shots/`: `dir.png` (frames one per row; `ls -la` refused),
`tab-frames.png` (Tab lists frames, not the sequence), `sudo-line.png` (hint "(needs sudo)" with sudo on the line),
`ghost.png`, `after-clear.png`, `after.png`.

## Status (2026-10-27)

Marcy approved the 5 MUSTs and the 12 SHOULDs; the 9 NICE items are backlog rows. Each fix has a test that fails on the
code before it.

| Finding | Where |
| --- | --- |
| M1 write scope: `allow <folder>` | 5c8d930 |
| M2 elevation survives Alt+Tab | 4f55ee6 |
| M3 `ls -la`, `dir /w`, `cd -` | 7a75a7d |
| M4 sequences in Tab | cd3598e |
| M5 `find` → `help -k` / `apropos` | 93a5700 |
| S1 sequence-aware `dir` | cd3598e |
| S2 multi-line paste | d73d8bf |
| S3 the CLI's conflicts | bf1dc4a |
| S4 plain errors | b7582ee |
| S5 foreign commands | b7582ee |
| S6 `history [N\|term]` | b8656c3 |
| S7 `--version`, `version` | 98fb947 |
| S8 dates and sizes | 9b8525c |
| S9 quieter blocks | 337d500 |
| S10 readline keys | fff05bd (also backlog 113) |
| S11 scripts and elevation | d73d8bf (also backlog 107, 110) |
| S12 values by meaning | 5620c7c (suggested by meaning, never taken in place: the Console accepts what the CLI accepts) |
| N1-N9 | BACKLOG rows 118-126 |
