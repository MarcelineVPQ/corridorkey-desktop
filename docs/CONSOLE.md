# The Console (main process)

The Console tab (BACKLOG row 95) is a command line inside the app for power users: its own command set, never a system
shell. This page is the main process side, `electron/main/console/` and `src/shared/console/`; the page is
`src/ui/pages/ConsolePage.tsx` and `src/ui/console/` (its use: docs/GUIDE.md "Console").

## Design

- **One parser.** `src/shared/console/parse.ts` reads a line the same way for the page's highlighting and completion
  and for execution: words, `'…'` (literal), `"…"` (`\"` and `\\` on Linux and macOS), a backslash escaping the next
  character outside quotes on Linux and macOS (a literal path separator on Windows, so `C:\shots\sh010` needs no
  quotes), `--` ending the options, an unquoted `?` (or `-h`, `--help`, `/?`) for help. Tokens carry kinds and source
  ranges; mistakes are errors with positions and a did-you-mean. An enum's value is taken in any case (`--format EXR`)
  and passed to the CLI as the CLI spells it (`exr`); a word that means one of its values (`MEANINGS` in registry.ts:
  `--device gpu` → auto, `--format mp4` → video, `--datatype fp32` → float) is suggested by meaning, not by spelling,
  and never taken in its place (a test checks every target against the CLI's spec). No variables, globs, pipes or
  redirections.
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
  combined like `-la`, and DOS's `/w /b /a /o:d` on every system; dot files only with `-a`; a frame sequence is one row,
  `sh010_plate.####.exr  1001-1100 · 96 frames · missing 1047`, `-f` lists its frames: `src/shared/console/sequences.ts`,
  which Tab completion uses too: one candidate per sequence, never one per frame), `cls` / `clear`. **Sequences
  everywhere:** a path whose file name is a frame pattern, `plate.####.exr`, `plate.%04d.exr`, `plate.$F4.exr` or
  `plate.@@@@.exr` (one digit per `@`; the frames read as ck-cli's `frame_of` reads them), is one item with its frame
  set to every built-in that takes a path: `dir <pattern>` lists that sequence's row (`-f` its frames), `open
  <pattern>` shows its first frame, `cd` and `allow` take its folder; a pattern with no frame says so with the `dir`
  line to type (`sequenceOf` in sequences.ts). `verify`'s missing frames come from the CLI as ranges, ready for a
  requeue (`missing frames: 1012-1015, 1040 (re-render them: -F 1012-1015,1040)`, docs/CLI.md); the block shows
  them as its last lines. (`@` is the Console's: corridorkey itself reads `####`, `%04d` and `$F4`.)
  `history [N|term]` (`--audit`: the elevated log), `version` (also `corridorkey --version`, `render --version`: the app's
  version, which its corridorkey shares; answered without running it), `run <file.ckcmd>` (a script of Console lines, one per line, `#` comments;
  each line through the same checks; stops at the first that fails; no script inside a script; its elevation: Security
  rules below). Several lines pasted at once are never joined: the page offers them as a script (Enter runs them in
  order through `consoleRunLines`, the same path as `run`; Esc keeps the first line; Ctrl+C drops them), `sudo <command>`,
  `sudo -k`, `farm export` (below), and `corridorkey render | verify | prepare | info` (also bare `render` …). Other command lines' names get
  an answer instead of "unknown command" (`ANSWERS` in registry.ts): `exit` / `quit` (the Console stays open), `rm` /
  `del` / `rmdir` (the Console never deletes files), `cp` / `mv`, `cat` / `type` / `echo` (a later version, Phase 4),
  `which`. Built-ins say a file system error in words with what to type (`fsErrorText` in paths.ts), never Node's
  `ENOENT: …, stat '…'`.
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
  command** copies the same line (before the job starts: its settings, TensorRT being chosen when it starts).
  `tests/unit/jobCommand.test.ts` parses the line with the Console's parser, maps it with ck-cli's own `RUN_OPTIONS`
  (read from args.rs) and checks the engine gets exactly the options the queue sends.
- **Farm export.** `farm export <openjd|deadline|opencue|flamenco|shell> [clips…|--queue] -o <folder>` writes the
  queued clips (named by path or file name; a clip not in the queue is refused: its settings come from the queue) as
  ready-to-submit jobs from the farm/ templates (bundled at build time, `electron/main/console/farm.ts`): an OpenJD job
  bundle per clip (`<clip>/template.yaml` with the clip's other flags in its Key step, `parameter_values.yaml`), Deadline
  10's job and plugin info (and the `CorridorKey/` plugin), an OpenCue `<clip>_opencue.sh` calling
  `corridorkey_submit.py` (beside it) with the shot's range and the booking from the job's `--max-vram`, a Flamenco job
  (`<clip>.flamenco.json` for `POST /api/v3/jobs`, and `scripts/corridorkey.js`), or shot lists for the shell farm (one
  per set of flags) with `run-shots.sh`. One task per shot (the app's matte); the farm writes EXR frames
  (`<results folder>/<clip>.####.exr`; a clip set to video says so); the models and ONNX Runtime are this computer's
  (the block says to change them for the workers); Deadline and OpenCue need the shot's frame range (a video from
  1001, a frame folder by its files): a clip without one is left out, and said. The folder goes through the write scope
  (`-o` is a written path); files already there are refused unless `sudo farm export … --overwrite` (the same
  elevation, dialog and audit as render's). Tests: `tests/unit/farmExport.test.ts` (each format parsed as its farm
  reads it: YAML, key=value, JSON, shell words), the runner's scope and sudo. `openjd check` and `openjd summary`
  passed on a generated bundle (openjd-cli in a scratch venv, 2026-10-27; it isn't installed for the tests, which
  check the bundle structurally).
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
  progress, the last 2000 lines, `dir`'s rows. The page keeps them quiet: a block's actions show on hover and on
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
  only, never on disk. A line the file scope refuses is refused before any dialog. `sudo` on a line that replaces
  nothing says so ("sudo isn't needed for this") and runs it as it is; the hint drops "(needs sudo)" once `sudo` is on
  the line. **Scripts** (`run`, pasted lines) never use, extend or grant the session's elevation: before any line runs,
  a line that replaces files must say `sudo` (else the whole script is refused), and all such lines are listed in ONE
  native dialog (confirmed: they run without asking again; cancelled: nothing runs), audited as `granted` / `refused`
  with the script's name and lines. (A typed folder name for bulk
  deletes comes with the first command that deletes in bulk; none does yet. A native message box has no text field,
  so it needs a dialog of the main process's own.)
- **Audit log** (`userData/console-audit.jsonl`): every elevation granted, refused or dropped (and why), every
  elevated command's argv, resolved targets and exit code, and every write folder allowed or removed. The `granted` and `run` entries are written before the
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
P10 in `consoleParse.test.ts`, the gate fixtures in `securityGate.test.ts`); P7-P9 pin open backlog rows 106-108.
The page (`consoleBlocks.test.ts`): the output is a plain region; one polite `role="status"` says each command's
start and end (`announcement()`), never its streamed lines.
