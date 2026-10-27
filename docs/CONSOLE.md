# The Console (main process)

The Console tab (BACKLOG row 95) is a command line inside the app for power users: its own command set, never a system
shell. This page is the main process side, `electron/main/console/` and `src/shared/console/`; the page is
`src/ui/pages/ConsolePage.tsx` and `src/ui/console/` (its use: docs/GUIDE.md "Console").

## Design

- **One parser.** `src/shared/console/parse.ts` reads a line the same way for the page's highlighting and completion
  and for execution: words, `'…'` (literal), `"…"` (`\"` and `\\` on Linux and macOS), a backslash escaping the next
  character outside quotes on Linux and macOS (a literal path separator on Windows, so `C:\shots\sh010` needs no
  quotes), `--` ending the options, an unquoted `?` (or `-h`, `--help`, `/?`) for help. Tokens carry kinds and source
  ranges; mistakes are errors with positions and a did-you-mean. No variables, globs, pipes or redirections.
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
  which Tab completion uses too: one candidate per sequence, never one per frame), `cls` / `clear`,
  `history [N|term]` (`--audit`: the elevated log), `version` (also `corridorkey --version`, `render --version`: the app's
  version, which its corridorkey shares; answered without running it), `run <file.ckcmd>` (a script of Console lines, one per line, `#` comments;
  each line through the same checks; stops at the first that fails; no script inside a script; its elevation: Security
  rules below). Several lines pasted at once are never joined: the page offers them as a script (Enter runs them in
  order through `consoleRunLines`, the same path as `run`; Esc keeps the first line; Ctrl+C drops them), `sudo <command>`,
  `sudo -k`, and `corridorkey render | verify | prepare | info` (also bare `render` …). Other command lines' names get
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
- **Output** goes to the page as blocks (`ConsoleBlock` in `src/shared/types.ts`): the line, its state and exit code,
  progress, the last 2000 lines, `dir`'s rows. The page keeps them quiet: a block's actions show on hover and on
  keyboard focus (`:focus-within`; opacity only, so Tab always reaches them; always shown without hover), a built-in's
  block is compact, `cd` prints nothing on success (`cd -` prints where it went). Updates are pushed on `ck:console-blocks`, at most 10 a second and only
  while the window is shown; the session (folder, elevation's end, the running line) rides in the app state.
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
