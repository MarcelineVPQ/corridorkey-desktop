# The Console (main process)

The Console tab (BACKLOG row 95) is a command line inside the app for power users: its own command set, never a system
shell. This page is the main process side, `electron/main/console/` and `src/shared/console/`; the page is
`src/ui/pages/ConsolePage.tsx` and `src/ui/console/` (its use: docs/GUIDE.md "Console").

Its page for users is the wiki's Console (`docs/wiki/Console.md`; `tools/check_wiki.mjs` fails when a built-in is
missing there).

## Design

- **One parser.** `src/shared/console/parse.ts` reads a line the same way for the page's highlighting and completion
  and for execution: words, `'…'` (literal), `"…"` (`\"` and `\\` on Linux and macOS), a backslash escaping the next
  character outside quotes on Linux and macOS (a literal path separator on Windows, so `C:\shots\sh010` needs no
  quotes), `--` ending the options, an unquoted `?` (or `-h`, `--help`, `/?`) for help. Tokens carry kinds and source
  ranges; mistakes are errors with positions and a did-you-mean. An enum's value is taken in any case (`--format EXR`)
  and passed to the CLI as the CLI spells it (`exr`); a word that means one of its values (`MEANINGS` in registry.ts:
  `--device gpu` → auto, `--format mp4` → video, `--datatype fp32` → float) is suggested by meaning, not by spelling,
  and never taken in its place (a test checks every target against the CLI's spec). The parser itself knows no
  variables, globs, pipes or redirections: `${name}` is filled in before it reads the line (Variables, below).
- **One registry.** `src/shared/console/registry.ts`: the built-ins and `corridorkey`'s commands. The CLI's part comes
  from `cliSpec.json`, which `tools/gen_cli_spec.mjs` writes from `corridorkey __spec --json` at build time (checked in;
  `tests/unit/cliSpec.test.ts` fails when it and the built binary differ). Each entry: name, aliases, arguments (kinds
  path / enum / number / frames / string, value names, values), description, examples; `render --overwrite` and
  `render --skip-existing` (it keys the whole set again unless every frame is there and whole: docs/CLI.md "Output
  safety") are marked destructive, each argument carries the CLI's own `conflicts_with` (the parser marks `-F` with
  `-s`/`-e`, `-q` with `-v`, `--overwrite` with `--skip-existing`, `-i` with INPUT before Enter), `render`'s `-o`, `--report`, `--temp` (and `verify`'s and `prepare`'s `--report`) as written paths.
- **Commands.** `help [command]` (also `command ?` and `man <command>`), `help -k <term>` / `apropos <term>` (search the help; `find` is
  kept free for a file search and says so), `cd` (`cd -`: the folder before), `pwd`, `allow [folder]` (File scope, below), `open [path]` / `start` (the file
  manager shows it, as Show in folder does: `shell.showItemInFolder`, which never opens or runs a file), `dir` / `ls` (`-l -a -t -S -r -1`,
  combined like `-la`, `-h` taken as GNU's human sizes, which it always shows (`ls -lh`, `-ltrh`; `-h` alone is help), and
  DOS's `/w /b /a /o:d` on every system; dot files only with `-a`; a file-name pattern typed unquoted, `ls *.exr`,
  `dir plates/sh0?0_*.exr`, lists what it matches there, by name as `for`'s globs do (a pattern in a folder name is
  refused; a quoted word or a variable's value is a name; a real folder with `[` in its name is itself: SME review
  2026-10-27 S1); a frame sequence is one row,
  `sh010_plate.####.exr  1001-1100 · 96 frames · missing 1047`, `-f` lists its frames: `src/shared/console/sequences.ts`,
  which Tab completion uses too: one candidate per sequence, never one per frame; grouped as lsseq and ck-cli's
  `frame_of` read a folder: an unpadded run, `frame.1` … `frame.120` (`frame.#.exr 1-120`), and a run that outgrows its
  padding, `sim.9999` `sim.10000`, are one sequence, while `a.0001` and `a.01` are two (SME review 2026-10-27 M2)), `cls` / `clear`. **Sequences
  everywhere:** a path whose file name is a frame pattern, `plate.####.exr`, `plate.%04d.exr`, `plate.$F4.exr` or
  `plate.@@@@.exr` (one digit per `@`; the frames read as ck-cli's `frame_of` reads them), is one item with its frame
  set to every built-in that takes a path: `dir <pattern>` lists that sequence's row (`-f` its frames; the summary counts the
  folder's other names as not matching the pattern, and "hidden" only for dot files `-a` shows), `open
  <pattern>` shows its first frame, `cd` and `allow` take its folder; a pattern with no frame says so with the `dir`
  line to type (`sequenceOf` in sequences.ts). `verify`'s missing frames come from the CLI as ranges, ready for a
  requeue (`missing frames: 1012-1015, 1040 (re-render them: -F 1012-1015,1040)`, docs/CLI.md); the block shows
  them as its last lines. (`@` is the Console's: corridorkey itself reads `####`, `%04d` and `$F4`.)
  `history [N|term]` (`--audit`: the elevated log), `version` (also `corridorkey --version`, `render --version`: the app's
  version, which its corridorkey shares; answered without running it), `run [--keep-going] <file.ckcmd>` (a script: Scripting, below; no script
  inside a script; its elevation: Security rules below). Several lines pasted at once are never joined: the page offers them as a script (Enter runs them in
  order through `consoleRunLines`, the same path as `run`; Esc keeps the first line; Ctrl+C drops them), `sudo <command>`,
  `sudo -k`, `farm export` (below), and `corridorkey render | verify | prepare | info` (also bare `render` …). Other command lines' names get
  an answer instead of "unknown command" (`ANSWERS` in registry.ts): `exit` / `quit` (the Console stays open), `rm` /
  `del` / `rmdir` (the Console never deletes files), `cp` / `mv`, `more` / `less` (`cat`, `head`, `tail`),
  `which`. Built-ins say a file system error in words with what to type (`fsErrorText` in paths.ts), never Node's
  `ENOENT: …, stat '…'`; one they didn't expect (a file whose stat works but whose open doesn't) ends the block failed
  in the same words (`cat: you have no permission to open …`), never a call with no block.
- **Running corridorkey.** The shipped binary (`engineFind.ts findCli`) is spawned with an argv, `shell: false`, its own
  process group, the engine's environment (`rustEngineEnv`, the app's models, runtime and TensorRT cache), in the
  Console's folder (on Windows corridorkey takes the current folder out of its DLL search first, `SetDllDirectoryW("")`
  in ck-cli's main, so a folder `cd` visited never supplies a DLL). The Console adds `--progress-format json` (the flag itself is refused: the Console shows progress)
  and, for `render` without `--temp`, a temporary folder in the app's cache. The CLI's JSON events become the block's
  progress (frames handed to the writers, never an estimate), phase and failure; its exit code is shown with its
  meaning (docs/CLI.md). Ctrl+C sends SIGTERM (the CLI stops cleanly after the frame it is on, 143); a second one kills
  the process group. On Windows (no SIGTERM for a console program, no process groups) the first one ends the tree with
  `taskkill /pid N /T /F` (System32's, by full path; the runner's own default there); the output stays safe (docs/CLI.md
  "Output safety"). One Console job at a time: a `run` script takes the slot before it reads its file, and a command
  checks the slot again right before it starts, with nothing awaited in between. `render` and `prepare` use the graphics card: refused
  while the queue runs; while they run the queue doesn't start, the memory estimate stops and the background TensorRT
  build waits. The app's quit stops a running corridorkey (SIGTERM, killed after 7 s): the CLI doesn't end with its
  parent on its own. Once the quit has begun nothing starts: a command still in its checks is refused.
- **Teach by echo.** Every job the queue starts carries its exact `corridorkey render …` line (`Job.command`, built by
  `src/shared/console/jobCommand.ts` from the job's settings with the mapping queue.ts sends the engine, and
  `--tensorrt --no-tensorrt-build` when the queue asked for TensorRT; a flag only where the job differs from the CLI's
  default). The queue's `started` hook hands it to `Console.echo`: an informational block (`echo`: where it came from;
  state done, no exit code, never run, not in the history), shown unless **Console settings → Show GUI jobs as
  commands** is off (a page setting, default on; the page filters, `visibleBlocks`). The Queue page's **Copy as
  command** copies the same line (before the job starts: its settings, TensorRT being chosen when it starts). The line
  is pasted into terminals too, so each word is quoted for a shell and the Console alike (`shellWord`; senior review
  2026-10-27 M3): on Linux and macOS in `'…'` (a `'` as `'\''`), where bash and zsh expand nothing; on Windows in
  `"…"`, and a path with `%`, `!`, `$`, a backtick or `"` gets no line at all (no quoting stops cmd.exe's `%…%` or
  PowerShell's `$` inside `"…"`): the Queue says why instead of the button, and nothing is echoed. A control character
  gives no line on any system. The line carries no runtime: pasted into a terminal, `corridorkey` falls back to the app's
  own install (docs/CLI.md "The runtime"; SME review 2026-10-27 S2), and in the Console its environment is the Engine
  page's, so the fallback never applies there.
  `tests/unit/jobCommand.test.ts` parses the line with the Console's parser, maps it with ck-cli's own `RUN_OPTIONS`
  (read from args.rs) and checks the engine gets exactly the options the queue sends.
- **Farm export.** `farm export <openjd|deadline|opencue|flamenco|shell> [clips…|--queue] -o <folder>` writes the
  queued clips (named by path or file name; a clip not in the queue is refused: its settings come from the queue) as
  ready-to-submit jobs from the farm/ templates (bundled at build time, `electron/main/console/farm.ts`): an OpenJD job
  bundle per clip (`<clip>/template.yaml` with the clip's other flags in its Key step, `parameter_values.yaml`; a frame
  folder's Input is `objectType: DIRECTORY`, chosen as a folder, not yet run on Deadline Cloud and said so: S7), Deadline
  10's job and plugin info and a Verify job's (`<clip>_verify_*`, Command=verify, submitted after the render with
  `deadlinecommand -SubmitMultipleJobs -dependent`), all in one batch, the export folder's name, with the `CorridorKey/`
  plugin (S4), an OpenCue `<clip>_opencue.sh` calling `corridorkey_submit.py` (beside it) with the shot's range and the
  booking from the job's `--max-vram`, a Flamenco job (`<clip>.flamenco.json` for `POST /api/v3/jobs`, and
  `scripts/corridorkey.js`), or shot lists for the shell farm (one per set of flags) with `run-shots.sh`, which runs every
  list (one failing doesn't stop the next; it exits 1 when any did), each logging into `logs/<list>/` (S6). One task per
  shot (the app's matte). **Where the frames land** (SME review 2026-10-27 M1): every format gives corridorkey the
  queue's own `-o <results folder>`, the CLI's folder layout, so the farm's frames are the GUI's and Copy as command's,
  `<results>/<clip>_<output>_exr/<clip>_<output>.####.exr` (a clip set to video says the farm writes EXR); Deadline names
  each output's folder and frames (`OutputDirectoryN` / `OutputFilenameN`, the shot's padding) and the block says where
  they land. **Frames already there**: one policy, replaced (`--overwrite` in every format; a farm retries a task, and the
  retry must replace what its first try wrote), said in the block (S5). **Options**: `--models DIR` and `--ort LIB` are
  the workers' paths (a kept variable works: `--models ${farm_models}`); without them the jobs carry this computer's and
  the block names them as this computer's (S3; Deadline's paths live in its plugin's settings). Deadline: `--group`
  (your GPU group: without one the block warns the job may reach a worker without a card), `--pool` (none: the
  repository's default) and `--priority` (0-100, default 50). Flamenco: `--platform linux|windows|darwin`, the
  submitter's (its two-way variables translate paths from it), default this computer's (S5). **Ranges**: Deadline and
  OpenCue need the shot's (a video from 1001; a frame folder from all of its frames, as corridorkey numbers them:
  `folderRange` in sequences.ts): a clip without one is left out, and said; a frame folder holding several sequences
  (or a sequence and other frames) refuses the export, naming them: corridorkey would key them as one clip (M2). A clip whose name, path, results
  folder, a flag's value, the runtime's paths or a Deadline setting has a control character (a new line, a tab) is refused, with which and
  why: it would add lines to the farm's files (senior review 2026-10-27 M1); so are two clips with one name (compared
  without case), whose job files would replace each other (S3). The folder goes through the write scope
  (`-o` is a written path), and so does each file it writes, resolved (a linked folder inside that leads out is
  refused); a file name that is a link is refused, dangling or not, with sudo too, and each file is written as a new one
  renamed over the name, so a link raced in after the checks is replaced, never written through (M2). Files already
  there are refused unless `sudo farm export … --overwrite` (the same elevation, dialog and audit as render's). Tests: `tests/unit/farmExport.test.ts` (each format parsed as its farm
  reads it: YAML, key=value, JSON, shell words; `run-shots.sh` run by `/bin/sh` with a stub), the runner's scope and
  sudo. `openjd check` and `openjd summary` (with the exported values) passed on a movie's and a frame folder's bundle
  (openjd-cli 0.8.0 in a scratch venv, 2026-10-27; it isn't installed for the tests, which check the bundle
  structurally).
- **Bookmarks and jumping.** `bookmark <name> [folder]` names a folder (the current one by default; a frame
  pattern's folder), `bookmark -d <name>` removes it, `bookmarks` (or `bookmark` alone) lists them; `@name` (and
  `@name/more`) is that folder for `cd`, `pushd`, `dir`, `open`, `allow` and `bookmark`, and Tab completes `@na` to
  the bookmarks and `@name/` inside one. A name starts with a letter or digit (then letters, digits, `_ . -`, at most
  64), so a frame token's `@@@@` is never read as one; an unknown `@name` is said ("No bookmark …"). Saved per user in
  settings (`consoleBookmarks`: name → absolute folder, at most 200, each checked on load). `j <part…>` (alias `z`)
  jumps like zoxide: the folders the history's lines were typed in, ranked by frecency (each line counts 4 within the
  hour, 2 within the day, ½ within the week, ¼ older: `src/shared/console/frecency.ts`), the best one whose path has
  every part in order with the last one in its last folder's name, still there, and not the current one; it prints
  where it went; `j` alone prints the ranking. `pushd <folder>` goes there and remembers the folder before, `pushd`
  alone swaps with the newest remembered, `popd` goes back, `dirs` lists them (0 is the current folder; at most 50,
  this session only); each prints the list, as bash does.
- **Variables** (`src/shared/console/vars.ts`; SME review item 6). `set name=value` (several at once; a name alone
  prints it; `set` alone lists them and the Console's own), `unset name…`, `echo …` prints its words. `${name}` is the
  only syntax, braces required: in this world `$F`, `$F4`, `$HIP`, `%04d`, `####`, `@@@@` and `!` are parts of file
  names, so nothing else is ever expanded. It is filled in outside quotes and inside `"…"`, never inside `'…'` or after
  a backslash (Linux, macOS); an unknown name or an unclosed `${` refuses the line with the reason. A word with a
  variable becomes ONE quoted word (on Windows `'…'` when the value has a `"`; a value with both quote marks is
  refused there): a value never splits into words and is never read as a flag, `sudo`, `?`, `--` or a command's name,
  so the flags a line has (and its destructive ones) are the ones typed, and the parser and the file scope check the
  filled-in line as any other. **In a `for` word** (`forWords` in vars.ts; SME review 2026-10-27 M3) the value is never a
  pattern either, but what was typed around it still is: `for f in ${show}/*.exr` is the files there, and a value's own
  `*`, `?`, `[` or frame token is just a character (each character is marked typed-unquoted or not; only typed ones make
  a glob or a frame pattern). **Lists** (S10): `${name[@]}`, a whole unquoted word of a `for`, is the value split at
  spaces, tabs and new lines, each piece one item (`set shots="sh010 sh020"`, `for s in ${shots[@]}`), never a flag or
  a pattern; a `${name}` with white space stays one item (zsh's rule) and the block says how to split it; `[@]`
  anywhere else is refused with why. A list is a plain value, so `set -p` keeps one; an item can't hold a space (give
  such names as words of their own). The Console's own are read-only: `${cwd}`, `${home}`, `${date}` (YYYY-MM-DD),
  `${time}` (HH-MM-SS: safe in a file name everywhere) and `${status}` (the last line's exit status: its exit code,
  else 0 done, 2 refused, 130 stopped, 1 failed). Typed lines and each script line are filled in when they run (after
  history expansion, as in bash); the block shows the line that ran and `from <what was typed>`, and the history keeps
  the `${name}`s (so `!!` fills them in again). The page colours a value with `${…}` as a value (it is checked once
  filled in). **Session or kept:** `set` is this session's (judgement call: a variable that outlives the session
  surprises in a script); `set -p` also keeps it in settings (`consoleVariables`: valid names, never a read-only one,
  strings without NUL up to 4096 characters, at most 200; checked on load), and a kept one stays kept when `set`
  again; `unset` removes it from both. At most 500 in a session.
- **Scripting** (`src/shared/console/script.ts`; SME review item 7: "a small language, not a shell"). A typed line or a
  script's text is a list of commands joined by `;` (or a new line), `&&` (the next runs only if this one ended 0) and
  `||` (only if it didn't); `for NAME in WORDS; do …; done`; `if LIST; then …; [else …;] fi` on the last exit status;
  `time COMMAND`. Nothing else: no subshells, no pipes (an unquoted `|` is refused with the reason), no redirections,
  no background jobs, no `elif`, `while` or functions. The separators are found with the tokenizer's own quote and
  escape rules (`"a;b"`, `'x||y'`, `d\;e` are words); keywords count only as a command's first word, unquoted; `#` at
  a line's start is a comment; a new line after `&&` / `||` continues it. A mistake in the program (a `for` without
  `done`, a stray `fi`) refuses it before anything runs, with where. Each command is one Console line: filled in
  (`${name}`, the loop's variable over the session's) and parsed and checked by the one parser when it runs, as its own
  block under the program's. **for**'s words: an unquoted word with `*`, `?` or `[…]` in its file name is the files
  that match there (by name; dot files only for a pattern starting with `.`; a pattern in a folder name is refused),
  an unquoted frame pattern (`plates/sh010.####.exr`, `%04d`, `$F4`, `@@@@`) its frames' files, anything else itself
(only the characters typed unquoted count, a variable's value never: Variables above; a loop's variable fills in an
inner loop's words);
  a pattern that matches nothing is an error (zsh's rule, never the pattern itself); at most 10 000 items (counted
  before they are added); a variable's value is never a pattern. **At most 10 000 commands in one program**, loops
  inside loops included (each is a block on the page; past it the program stops, failed, and says so), and the event
  loop gets a turn before each command, so Ctrl+C, the page's updates and the window reach a loop of built-ins at once
  (senior review 2026-10-27 M4). The loop's variable is gone after the loop (one set before comes back). **Exit status:**
  each command's (`statusOf`: its exit code, else 0 done, 2 refused, 130 stopped, 1 failed) is `${status}` and what
  `&&`, `||` and `if` read; the program ends as its last command did. **Stopping:** a typed line goes on after a
  failure, as bash does; a script (`run`, pasted lines) stops at a command that fails at the end of its `&&`/`||`
  chain (bash's `set -e`: never one on the left of `&&` / `||`, never an `if`'s condition) and says
  `stopped at line N`; `run --keep-going` goes on, counts them and still ends failed. **One job:** a program takes the
  Console's one slot for all of it (a typed `cd a; dir` while a render runs is refused as busy) and frees it however it
  ends (an error inside it too); Ctrl+C stops it after the command it is in (a running corridorkey as usual). **time** prints `time: 2.0 s` after the command, with a
  render's frames and frames per second from its own JSON events (`· 50 frames · 25.00 fps`); `time` goes first
  (`sudo time …` says so). A program's elevation is a script's (Security rules): the commands that replace files say
  `sudo`, all listed in one dialog up front (for a typed line: "the line typed"), never the session's elevation.
  The page colours each command in place and Tab completes the command the cursor is in (`parseLine`,
  `commandStart`), a `for`'s words as files.
- **File built-ins** (read-only, read anywhere; `electron/main/console/files.ts`): `cat` / `type FILE…` a text file's
  first 2000 lines (at most 1 MiB read; a file with a NUL in its first 8 KiB is binary and refused; several: each
  under `==> name <==`), `head` / `tail [-n N] FILE` (default 10, at most 2000; `tail` reads only the file's last MiB),
  `wc FILE…` (lines, words, bytes; read 1 MiB at a time, up to 256 MiB; several: a total), `du [FOLDER…]` (each folder
  inside with its size, human, then the total; links not followed; past 200 000 entries the sizes say `≥`), `tree
  [FOLDER] [-L N] [-a]` (depth 2 by default, at most 6; sequences as one row with their frames; at most 1000 rows;
  dot files with `-a`). Bytes come through `ConsoleFs.readRange` (one bounded read; never a whole file in memory).
  The long ones, `du`, `tree`, `wc` and `j` (a stat per remembered folder, one may be a share that is gone), take the
  Console's one slot like a job (another command is busy meanwhile; in a program, the program's) and Ctrl+C stops
  them at the next entry, chunk or folder, `cancelled` (senior review 2026-10-27 S6); `cat`, `head` and `tail` read
  at most 1 MiB once and run as before.
- **doctor** (`doctor --json`): every check in one go, one row each (✓ ok, ⚠ warning, ✗ problem) and under each problem
  its exact fix (a Console line or an App action): the corridorkey command line (found), the graphics card and driver,
  ONNX Runtime and the models (all three from `corridorkey info --json`: it loads the runtime and asks the driver, never
  keys, so it takes no GPU slot and runs while the queue does; a runtime that doesn't load is its row, with the CLI's
  own message), TensorRT (the Engine page's state: off, on but not downloaded, on and how many size ranges are built)
  and ffmpeg (the app's check: ffmpeg, ffprobe and the encoders the outputs need) from `ConsoleDeps.doctor`, and each
  folder the Console writes to (the results folder, the cache folder, the allowed ones): there, writable, its disk's
  free space (✗ under 2 GiB, ⚠ under 20 GiB). It ends failed (exit 1) when a row is ✗, so a script can stop on it.
  Tests inject the checks and a fake `info` whose JSON is the real CLI's (`models.assets` is a map of the five
  networks; a model set info can't open is the Models row, a runtime that doesn't load the ONNX Runtime row); an
  isolated copy ran it against the real `corridorkey info` (CPU device).
- **Output** goes to the page as blocks (`ConsoleBlock` in `src/shared/types.ts`): the line, its state and exit code,
  progress, the last 2000 lines, `dir`'s rows, `doctor`'s rows. A program's commands (blocks with a parent) are one row
  each (SME review 2026-10-27 S8; `childRow` / `childOpens` in model.ts): a button with ✓ / ✗ / ■, the line, its time
  and its last output line (its paths shortened as below, whole on hover), a filled-in line with its `from <what was
  typed>`; click, Enter or Space shows the whole block, whose header then has a visible Collapse button;
  one that runs, failed or was refused shows whole on its own. A listing's Name column takes the room and stays on one
  line (a long name or a sequence's gaps end in …, never broken inside a number; the whole text on hover and in Copy
  output); `doctor` is a table (mark, check, detail, a problem's fix on its own line under its detail); `tree`'s
  lines are a drawing (`nowrap`: never wrapped, the block scrolls sideways); the absolute paths a block names (`paths`,
  `DoctorRow.path`: dir's folder, doctor's, `bookmarks`, `j`, `dirs`, `cd -`, `set`'s `cwd` and `home`) show as the
  app shows paths, `~` and the
  middle as … (`shortenKnown` in model.ts), whole on hover and in Copy output. The page keeps them quiet: a block's actions show on hover and on
  keyboard focus (`:focus-within`; opacity only, so Tab always reaches them; always shown without hover), a built-in's
  block is compact, `cd` prints nothing on success (`cd -` prints where it went). Updates are pushed on `ck:console-blocks`, at most 10 a second and only
  while the window is shown; the session (folder, elevation's end, the running line) rides in the app state.
- **History shortcuts** (`src/shared/console/expand.ts`), typed lines only (never a script's, bash's non-interactive
  rule): `!!` the line before, `!N` line N (the stable numbers), `!-N` the Nth before, `!prefix` the newest line
  starting so, `!$` the line before's last word (as typed, quotes kept), `^old^new` the line before with its first
  `old` replaced; `sudo !!` is `sudo` and the line before, and the "replaces files" refusal says to type it. The main
  process expands from the whole history (an event not found is refused, not kept); the expanded line is what runs,
  what the block shows (its first line `from <what was typed>`) and what the history keeps, as in bash. Frame tokens
  and file names stay literal (SME review): a `!` expands only at a word's start, outside quotes, not escaped (`\!`),
  and only before `!`, a digit, `-` and a digit, `$` (not `$F`) or a letter; so `sh010!.mov`, `'take!!'`, `!####`,
  `!%04d`, `!@@@@`, `!$F4` and `!=` are as typed, and `^` counts only at the line's start. The page previews it from
  its history (the hint says "Enter runs: …", the line reads plain). Alt+. inserts the line before's last word.
- **History** (`userData/console-history.jsonl`): the lines typed, across restarts, the newest 5000, consecutive
  duplicates once, a line typed with a leading space not at all (bash's ignorespace). Each line has a stable number
  (it never changes, also across compaction; for `!N` later), its folder and time (`{n, time, line, cwd}`), and its end
  once known (an `{n, exit, state}` row appended when its block ends). `history [N|term]` prints the last N (default
  50) or the lines whose text or folder contains the term: number, local time, ✓ or ✗ with the exit code, the line, its
  folder. Ctrl+R searches it; the History panel shows the number and ✓ / ✗ (`consoleHistory` returns the entries).

## Security rules

- **Never a shell.** The page sends a line; the main process parses and checks it again with the same parser,
  whatever the page showed. Built-ins run in the main process; `corridorkey` is one fixed program run with an argv.
  The security gate (`.hooks/check_electron_security.sh`) forbids in electron/ and src/: `exec` / `execSync`,
  child_process imported whole or by `import()`, and, unless the line or the one above says `gate: shell-ok — why`, a
  `shell:` option other than `false`, spawning a shell by name (sh, bash, cmd.exe, powershell, pwsh…), a shell's
  command-string argument (`"-c"`, `"/c"`, `"-Command"`) and `shell.openPath`.
- **IPC.** The Console's channels (`consoleRun`, `consoleCancel`, `consoleComplete`, `consoleHistory`,
  `consoleElevationDrop`) answer only the app's own page (its window's top frame), and check every argument (a line:
  a string of at most 8192 characters without NUL; the cursor within it). The preload exposes named functions only.
- **File scope: read anywhere, write only into chosen folders.** Reading (inputs, hints, `dir`, `cd`, Tab completion,
  scripts) goes wherever the user can read. A path a command writes to (`-o`, `--report`, `--temp`, a `--job` file's
  `output_dir` / `temp_dir`) must be inside the results folder (App settings), the cache folder (the chosen one and the
  system's), a queued clip's results folder, or a folder allowed with `allow <folder>` (alias `trust`): a native
  confirmation in the main process names the folder and says the Console may then write there and in every folder
  inside it; confirmed, it is audited (`allowed`) and saved in settings (`consoleWriteFolders`: absolute paths only,
  each once, at most 100, checked on load), and App settings → Console lists each with **Remove** (no confirmation and
  no sudo: removing only narrows the scope; audited as `removed`). `allow` alone lists them. A folder the Console may
  already write to needs no dialog; nothing adds one without it. Every "outside the folders the Console may write to"
  refusal ends with the exact line to type, `allow "<folder>"` (the folder typed with a trailing separator, else the
  nearest existing folder above the path). It is resolved with realpath first (symlinks and `..`; a path that
  doesn't exist yet through its nearest existing parent; without case on Windows and macOS), and the resolved path is
  what corridorkey is given. Anything else is refused with the reason. Only `--ocio`'s `ocio://` names pass unchecked
  (they name a built-in config); any other value is a path (`C://…` is one on Windows). A `--job` file is read and
  parsed by the app (at most 1 MiB, a regular file) or refused; its checked `output_dir` and `temp_dir` go to
  corridorkey as resolved `--output` / `--temp`, which win over the file, so a file changed after the check changes
  nothing.
- **The runtime is the Engine page's.** `--models` and `--ort` take only what the Engine page lists or uses (ONNX
  Runtime is a library: loading one runs its code).
- **Elevation (`sudo`).** A destructive command (`render --overwrite`, `render --skip-existing`) runs only as
  `sudo <command>`. Not elevated, a native dialog shows the line as typed, the command as it runs (each word quoted as
  the Console reads it, without the Console's own `--progress-format` and temporary folder; control and bidi
  characters as `\u{…}`) and its targets: the files at the run's names there now (`<clip>_…` and inside its
  `<clip>_…_exr` folders, the clip named as ck-core's `raw_clip_name` does; a pattern's frames; a file) and their
  bytes; confirmed, the Console stays elevated for 5 minutes, each elevated command extending it, never past 15
  minutes after the confirmation. Dropped by `sudo -k` (or the panel), a screen lock or sleep (Electron's `powerMonitor` `lock-screen` / `suspend`),
  quit and restart, never by the window losing focus (Alt+Tab to Nuke and back is the look-dev loop sudo is for); it lives in memory
  only, never on disk. **Linux** has no `lock-screen` event (Electron's is macOS and Windows only; senior review
  2026-10-27 S1): while elevated, the app reads this login session's `LockedHint` from systemd-logind every 5 s
  (`/usr/bin/busctl get-property org.freedesktop.login1 …/session/auto … LockedHint`: an argv, no shell, at most 2 s;
  KDE's and GNOME's lockers set it) and a locked screen drops the elevation (`LinuxLockWatch` in elevation.ts). Where
  it can't be read (no logind, no busctl, not in a login session) the window losing focus drops it instead: safety
  over the Alt+Tab loop. The read answered on Marcy's KDE desktop (`b false`); a real lock wasn't triggered on her
  screen to test it, the decision logic is tested with a fake reader. A line the file scope refuses is refused before any dialog. `sudo` on a line that replaces
  nothing says so ("sudo isn't needed for this") and runs it as it is. **The next free version** (SME review
  2026-10-27 S9, a complement to the model, not a change): a folder in `render`'s `-o` named with `v` and `#`s,
  `-o key/sh010_v###/` (a separator follows it, so it is never a frame pattern's file name), becomes the next number its
  parent doesn't have (`sh010_v004` when v001-v003 are there; padded to the #s; `nextVersion` in paths.ts): it replaces
  nothing, so it needs no sudo; the file scope checks the resolved path as any other, the block says it
  (`-o: the next free version is …`) and the audit log keeps it (`version`, the line and the path); the hint drops "(needs sudo)" once `sudo` is on
  the line. **Scripts** (`run`, pasted lines) never use, extend or grant the session's elevation: before any line runs,
  a line that replaces files must say `sudo` (else the whole script is refused), and all such lines are listed in ONE
  native dialog (confirmed: they run without asking again; cancelled: nothing runs), audited as `granted` / `refused`
  with the script's name, lines and targets. The dialog shows each line with its `${…}` filled in (`→ …`) where the
  values are known before it runs (a variable no line of the program sets, unsets or loops over, and `${home}`), else
  says they are filled in when it runs; and what the lines would replace, counted as the single command's dialog counts
  it (a folder given relative to the Console's folder is counted only while the script doesn't `cd`, `pushd`, `popd`
  or `j`: then the dialog says so). A line shown filled in runs only as shown (senior review 2026-10-27 S2). (A typed folder name for bulk
  deletes comes with the first command that deletes in bulk; none does yet. A native message box has no text field,
  so it needs a dialog of the main process's own.)
- **Audit log** (`userData/console-audit.jsonl`): every elevation granted, refused or dropped (and why), every
  elevated command's argv, resolved targets and exit code, every write folder allowed or removed, and every next free
  version a render's `-o` was given. The `granted` and `run` entries are written before the
  command runs; when either can't be written the command is refused (never elevated unlogged). Only ever opened to append; the app never rewrites or
  prunes it. `history --audit` shows its end.

## Tests

`tests/unit/consoleParse.test.ts` (the tokenizer and parser: quotes, escapes, Windows paths, unicode, unterminated
quotes, flags, values, help, sudo; the registry), `consoleSafety.test.ts` (file scope with real symlinks and `..` in a
temp folder, Windows and macOS rules as logic; elevation's TTL, extension, cap, drop, never persisted; the audit log
append-only; the history cap), `consoleRunner.test.ts` (a fake spawn: the exact argv, no shell, the process group,
cancel then kill, the JSON events, one job at a time, the queue's card, refusals, the sudo flow and its audit, the
built-ins, scripts, quit, completion, the throttled push, the IPC checks), `cliSpec.test.ts` (the drift check). The senior review of 2026-10-26 (docs/REVIEW_CONSOLE_2026-10-26.md) left 14
probes; each is a regression test (`consoleRunner.test.ts` "review 2026-10-26 probes", P9 in `consoleSafety.test.ts`,
P10 in `consoleParse.test.ts`, the gate fixtures in `securityGate.test.ts`); P7-P9 pin open backlog rows 106-108. The
Phase 4 senior review (docs/REVIEW_CONSOLE_P4_2026-10-27.md) proved its findings with probes; each is a test: hostile
names per farm format and Deadline's argument split (`farmExport.test.ts`), the shell-safe copied line read back by
`/bin/sh` (`jobCommand.test.ts`), the 30 000-line program (`consoleScript.test.ts`), and in `consoleRunner.test.ts`
links in the export folder, a program's throws, budget and Ctrl+C, the long built-ins' slot, the script confirmation's
filled-in lines and targets, and the Linux screen-lock watch ("review 2026-10-27" blocks). The Phase 4 SME review
(docs/REVIEW_CONSOLE_P4_SME_2026-10-27.md) left its probes as tests too: the unpadded and past-9999 folders
(`consoleSequences.test.ts`, the Deadline export in `consoleRunner.test.ts`), the farm's `-o` against the queue's and
each format's wrangler items (`farmExport.test.ts`), `${dir}/*.exr` and the list (`consoleRunner.test.ts`,
`consoleVars.test.ts`), `ls *.exr` / `ls -lh`, the next free version, the program's rows (`consoleBlocks.test.ts`, the
block rendered to markup) and the CLI's fallback (ck-cli `appinstall.rs` and `tests/cli.rs`).
The page (`consoleBlocks.test.ts`): the output is a plain region; one polite `role="status"` says each command's
start and end (`announcement()`), never its streamed lines.
