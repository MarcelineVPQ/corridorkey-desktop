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
  path / enum / number / frames / string, value names, values), description, examples; `render --overwrite` is marked
  destructive, `render`'s `-o`, `--report`, `--temp` (and `verify`'s and `prepare`'s `--report`) as written paths.
- **Commands.** `help [command]` (also `command ?`), `find <term>`, `cd`, `pwd`, `dir` / `ls`, `cls` / `clear`,
  `history` (`--audit`: the elevated log), `run <file.ckcmd>` (a script of Console lines, one per line, `#` comments;
  each line through the same checks; stops at the first that fails; no script inside a script), `sudo <command>`,
  `sudo -k`, and `corridorkey render | verify | prepare | info` (also bare `render` …).
- **Running corridorkey.** The shipped binary (`engineFind.ts findCli`) is spawned with an argv, `shell: false`, its own
  process group, the engine's environment (`rustEngineEnv`, the app's models, runtime and TensorRT cache), in the
  Console's folder. The Console adds `--progress-format json` (the flag itself is refused: the Console shows progress)
  and, for `render` without `--temp`, a temporary folder in the app's cache. The CLI's JSON events become the block's
  progress (frames handed to the writers, never an estimate), phase and failure; its exit code is shown with its
  meaning (docs/CLI.md). Ctrl+C sends SIGTERM (the CLI stops cleanly after the frame it is on, 143); a second one kills
  the process group. On Windows (no SIGTERM for a console program) the first one ends the tree; the output stays safe
  (docs/CLI.md "Output safety"). One Console job at a time. `render` and `prepare` use the graphics card: refused
  while the queue runs; while they run the queue doesn't start, the memory estimate stops and the background TensorRT
  build waits. The app's quit stops a running corridorkey (SIGTERM, killed after 7 s): the CLI doesn't end with its
  parent on its own.
- **Output** goes to the page as blocks (`ConsoleBlock` in `src/shared/types.ts`): the line, its state and exit code,
  progress, the last 2000 lines, `dir`'s rows. Updates are pushed on `ck:console-blocks`, at most 10 a second and only
  while the window is shown; the session (folder, elevation's end, the running line) rides in the app state.
- **History** (`userData/console-history.jsonl`): the lines typed, across restarts, the newest 5000, consecutive
  duplicates once; Ctrl+R searches it (`consoleHistory`).

## Security rules

- **Never a shell.** The page sends a line; the main process parses and checks it again with the same parser,
  whatever the page showed. Built-ins run in the main process; `corridorkey` is one fixed program run with an argv.
  The security gate (`.hooks/check_electron_security.sh`) forbids `shell: true` and `exec` / `execSync` in electron/
  and src/.
- **IPC.** The Console's channels (`consoleRun`, `consoleCancel`, `consoleComplete`, `consoleHistory`,
  `consoleElevationDrop`) answer only the app's own page (its window's top frame), and check every argument (a line:
  a string of at most 8192 characters without NUL; the cursor within it). The preload exposes named functions only.
- **File scope: read anywhere, write only into chosen folders.** Reading (inputs, hints, `dir`, `cd`, Tab completion,
  scripts) goes wherever the user can read. A path a command writes to (`-o`, `--report`, `--temp`, a `--job` file's
  `output_dir` / `temp_dir`) must be inside the results folder (App settings), the cache folder (the chosen one and the
  system's), or a queued clip's results folder. It is resolved with realpath first (symlinks and `..`; a path that
  doesn't exist yet through its nearest existing parent; without case on Windows and macOS), and the resolved path is
  what corridorkey is given. Anything else is refused with the reason.
- **The runtime is the Engine page's.** `--models` and `--ort` take only what the Engine page lists or uses (ONNX
  Runtime is a library: loading one runs its code).
- **Elevation (`sudo`).** A destructive command (`render --overwrite`) runs only as `sudo <command>`. Not elevated, a
  native dialog names the exact command (as it will run) and its targets (files and bytes there now); confirmed, the
  Console stays elevated for 5 minutes, each elevated command extending it, never past 15 minutes after the
  confirmation. Dropped by `sudo -k` (or the panel), the window losing focus, quit and restart; it lives in memory
  only, never on disk. A line the file scope refuses is refused before any dialog. (A typed folder name for bulk
  deletes comes with the first command that deletes in bulk; none does yet. A native message box has no text field,
  so it needs a dialog of the main process's own.)
- **Audit log** (`userData/console-audit.jsonl`): every elevation granted, refused or dropped (and why), and every
  elevated command's argv, resolved targets and exit code. Only ever opened to append; the app never rewrites or
  prunes it. `history --audit` shows its end.

## Tests

`tests/unit/consoleParse.test.ts` (the tokenizer and parser: quotes, escapes, Windows paths, unicode, unterminated
quotes, flags, values, help, sudo; the registry), `consoleSafety.test.ts` (file scope with real symlinks and `..` in a
temp folder, Windows and macOS rules as logic; elevation's TTL, extension, cap, drop, never persisted; the audit log
append-only; the history cap), `consoleRunner.test.ts` (a fake spawn: the exact argv, no shell, the process group,
cancel then kill, the JSON events, one job at a time, the queue's card, refusals, the sudo flow and its audit, the
built-ins, scripts, quit, completion, the throttled push, the IPC checks), `cliSpec.test.ts` (the drift check).
