# Console Phase 4 + SME fixes: independent senior review (2026-10-27)

Scope: `git diff 311340c..HEAD` on `feat/console` (23 commits, 59 files, +6426/-364). Read: CLAUDE.md,
docs/CONSOLE.md, docs/GUIDE.md "Console", docs/CLI.md, all of `electron/main/console/`, `src/shared/console/`, the
index.ts/settings.ts/validate.ts/queue.ts diffs, the farm templates and plugins it bundles, the ck-cli diff and the tests.
Probes ran as throwaway vitest files outside the repo (memory-capped, CPU only, never the app or a GPU); the repo's own
gates, 580 unit tests, `tsc -b` and `cargo test -p ck-cli` (36 tests) all pass.

## Verdict

**Not ready to merge: 4 MUST.** Grade **C+** (B+ for the Console core alone).

The interpreter's main security design holds, and I tried hard to break it: a `${name}` value is always one quoted word,
so variables, `for` items and history can't add a flag, `sudo`, `--` or a command name (probe P11, Linux and Windows
rules). Script elevation is declared up front and never inherits. Settings are shape-checked on load. Reads are bounded.
The serious problems are elsewhere:

1. **`farm export` writes hostile file names into executable farm files without escaping.** A clip name with a new line
   puts its own lines into the OpenCue `.sh` (proved: running it executed `touch PWNED`), the Deadline key=value files
   and the shell shot lists.
2. **`farm export` follows a symlink planted in the export folder** and writes outside the allowed folders, with no sudo
   (proved).
3. **"Copy as command" / teach-by-echo lines are not shell-safe.** They use `"…"` with `$( )` and backticks left as they
   are, and `%VAR%` bare on Windows. A crafted clip name runs when the line is pasted into a terminal, and the code says
   the line is meant for "the Console or a farm".
4. **An exception inside a program leaves the Console's job slot taken until restart** (proved with an unreadable file
   and with a `for` over more than 130k matches). A loop of built-ins also never yields to the event loop: Ctrl+C can't
   arrive, and block memory grows with no limit (proved: a 5 ms timer fired after 967 ms; nested loops multiply the
   10 000 cap).

## MUST

### M1. Farm export: a new line in a clip's name injects lines into executable farm files (shell, Deadline, OpenCue)
- **Where:** electron/main/console/farm.ts:191-192 (OpenCue `#` comment line with `${j.name}`), :136 + :139-159
  (Deadline `k=v` lines: `Name`, `OutputFilename0`, `InputPath`, `OutputPath`, `OutputDirectory0`), :239 (shell
  `shots.txt` INPUT\tOUTPUT rows), :124 (OpenJD `parameter_values.yaml` comment line).
- **Failure:** Linux and macOS allow a new line in a file or folder name. Footage from outside (a vendor delivery, a
  shared plate folder) can carry one. A clip named `x⏎touch PWNED⏎x.mov` makes `x_opencue.sh` contain a line
  `touch PWNED`. The note tells the user to run that file (`sh <clip>_opencue.sh`). In Deadline's job info, a clip named
  `a⏎Plugin=CommandLine⏎b.mov` adds `Plugin=CommandLine` as its own line, so any job or plugin key (scripts, plugin,
  environment) can be set on the farm. A new line in a folder name does the same to `InputPath=` and the other keys.
  Shot lists gain extra rows (an INPUT/OUTPUT pair the shell farm will write to).
- **Evidence:** proved. Probe P1 printed the generated files, and running the generated `x_opencue.sh` in a temp folder
  (`env -i PATH=/usr/bin:/bin sh ./x_opencue.sh`) created `PWNED` before the script's own syntax error.
- **Fix:** refuse to export a job whose clip path, output folder, name or flag values contain a control character
  (`[\u0000-\u001f\u007f]`), and say which clip and why. Escaping can't save `k=v` or the TSV list. Also drop the clip
  name from comment lines, or pass it through `visible()`. Add hostile-name cases (new line, `'`, `"`, `$`, `%`, `{{`)
  to tests/unit/farmExport.test.ts for every format.
- **Effort:** S (1-2 h with tests).

### M2. Farm export follows symlinks inside the export folder: writes outside the allowed folders, without sudo
- **Where:** electron/main/console/runner.ts:984-1010. Only `-o` goes through `checkWrite`. Each file is then
  `a.join(w.path, …)`, checked for existence with `stat` (which follows links), and written with `mkdir` and `writeFile`
  (which follow links too).
- **Failure:** in a shared export folder, anyone who can write there can plant `sh010_job_info.txt → ~/.bashrc` (a
  dangling link is "not there", so it needs no sudo) or `CorridorKey → /anywhere`. The export then writes through the
  link, outside every allowed folder. With an existing target, `sudo … --overwrite` replaces it, and the dialog names
  the link path, not its target. This breaks the Console's central rule: write only into chosen folders.
- **Evidence:** proved (probe P9). The export folder sat inside the write root. A dangling file link and a linked
  `CorridorKey/` folder both pointed outside it. The export finished `done`, `elevated: false`, and the outside folder
  now held `planted.txt`, `CorridorKey.py`, `.param` and `.options`.
- **Fix:** resolve and check every written path with `checkWrite` (realpath of its parent) before writing. Check the
  existing file with `lstat`, and refuse a link at a written name. Write with `O_CREAT|O_EXCL`, or to a temp file and
  `rename`, so a link raced in after the check is replaced, not followed. Add a test with a dangling link and a linked
  sub-folder.
- **Effort:** S-M (2-3 h).

### M3. "Copy as command" and the echoed line run attacker text when pasted into a shell
- **Where:** src/shared/console/jobCommand.ts:75-77 → `quoteArg` (src/shared/console/parse.ts:134-139), used by
  QueuePage `CopyCommand` ("for the Console or a farm") and `Job.command`.
- **Failure:** on POSIX, `quoteArg` falls back to `"…"` and escapes only `\` and `"`. Bash and zsh still expand `$( )`,
  `` ` ` `` and `$VAR` inside double quotes, and `!` interactively. On Windows, a plain word may contain `%`, so
  `C:\shots\%PATH%\a.mov` is left unquoted and cmd.exe expands it. A clip folder named `$(curl …|sh)` runs that command
  when a TD pastes the copied line into a terminal, which is the whole point of the button. The code comment says
  "quoted as the Console (and a shell) reads it", and the result doesn't match that.
- **Evidence:** proved (probe P7). The output was
  `corridorkey render -i "/shots/$(touch /tmp/PWNED2)/a.mov" -o "/r/`id`" …` and `-i C:\shots\%PATH%\a.mov` on Windows.
- **Fix:** give the clipboard and echo their own shell quoting: POSIX `'…'` with `'\''` (as `sh()` in farm.ts already
  does), and on Windows always `"…"` plus a refusal or note for `%` and `!`. Or refuse to offer the command for a path
  with `$`, `` ` ``, `%`, `!` or control characters. The Console's tokenizer already reads `'…'` literally, so one form
  can work for both. Add these cases to jobCommand.test.ts.
- **Effort:** S (1 h).

### M4. Program robustness: a throw leaves the job slot taken until restart; loops of built-ins block the main process and their memory grows
- **Where:** runner.ts:1351-1363 (`done` IIFE: no try/finally). runner.ts:1095-1100 (cat/head/tail/wc:
  `readRange` throws EACCES after `stat` succeeded). runner.ts:1455 (`out.push(...hits)`: RangeError past ~130k
  matches; the `ITEMS_MAX` check comes after the push). runner.ts:1367-1414 (a body of built-ins only awaits
  already-resolved promises, so the loop runs as one long microtask chain). push.ts (`pending` map grows while the
  timer can't fire).
- **Failure:**
  (a) `cat secret; echo after`, with `secret` unreadable (stat works, open fails), or `for f in *.exr; …` in a folder
  with 140k frames. The exception escapes `runList`, `this.job` is never cleared, and every later `render`, `run` or
  `a; b` answers "Busy with …" until the app restarts. Ctrl+C can't clear it (`cancel()` only counts).
  (b) The same single-line `cat secret` rejects the IPC call. The page awaits it without a catch, so no block appears
  and the renderer logs an unhandled rejection.
  (c) `for a in *; do for b in *; do echo ${a} ${b}; done; done` never yields. Ctrl+C (IPC), the 10/s push and window
  events can't run until it ends. The 10 000 cap is per loop, so nesting multiplies it (10k × 10k = 10⁸ blocks). Every
  block also lands in BlockPusher's `pending` map, which can't drain, so memory grows until the main process dies.
- **Evidence:** proved. P3: after `cat <0000 file>; echo after`, the next `echo a; echo b` was refused "Busy with cat …".
  The single line rejected with `EACCES`. P4: RangeError at runner.ts:1455, then the slot stayed taken. P5: 300×300
  echo, and a 5 ms `setTimeout` (standing in for Ctrl+C) fired after 967 ms, when the loop had already finished.
  Scaled up, 2000 files nested is about 45 s of frozen app.
- **Fix:** put `try/finally` around the program's `done` (release the slot, finish the block `failed` with the error in
  words), and a `try/catch` in `runLine` that turns any built-in throw into a failed block (`fsErrorText`). Check
  `ITEMS_MAX` before pushing, and push in a loop. Add a program-wide command budget (for example 10 000 commands for
  the whole program, not per loop). After every N commands, `await new Promise(setImmediate)` so cancel and pushes get
  through. Tests: an unreadable file inside a program, then a compound line runs; a nested loop is cut at the budget;
  `cancel()` from a timer stops a loop of built-ins.
- **Effort:** S-M (2-3 h).

## SHOULD

### S1. `lock-screen` doesn't exist on Linux: since the blur drop was removed, locking the screen keeps the elevation
- **Where:** electron/main/console/elevation.ts:50-56, index.ts:1262. docs/CONSOLE.md says "Dropped by … a screen lock".
- **Failure:** Electron 45 types mark `powerMonitor` `'lock-screen'` as `@platform darwin,win32`. On Linux (Marcy's
  desktop) a locked screen leaves the Console elevated for up to 15 min. The test uses a fake emitter, so it can't see
  this.
- **Evidence:** code-read (node_modules/electron/electron.d.ts:11167).
- **Fix:** on Linux, poll `powerMonitor.getSystemIdleState(…)` for `"locked"` while elevated, or drop the elevation
  after N minutes idle (`getSystemIdleTime`). Or document the gap and keep the 5 min TTL as the guard.
- **Effort:** S.

### S2. A program's one confirmation shows the lines before `${…}` are filled in, and no targets
- **Where:** runner.ts:1331-1349.
- **Failure:** `set o=…; sudo render x.mov -o ${o} --overwrite` asks "sudo render x.mov -o ${o} --overwrite" (P6). The
  folder it will overwrite and the file and byte counts (which the single-line dialog shows) are missing. Inside a `for`
  the user confirms a template, not what it does. The write scope still holds, so this is about informed consent, not
  scope.
- **Fix:** say in the dialog that a line with `${…}` or a loop variable is filled in when it runs, and for a line
  without them show its `measureTargets`. Or check each elevated line's expanded form against what was confirmed.
- **Effort:** S-M.

### S3. Farm export: two queued clips with the same name overwrite each other's job files without a word
- **Where:** farm.ts:66/71/81/87/230 (paths by `j.name` only), runner.ts:986-988 (the "already there" check runs
  before the export, not across its own files).
- **Evidence:** proved (P2). `/a/sh010.mov` and `/b/sh010.mov` gave "Wrote 7 files" (listing `sh010_job_info.txt`
  twice). The folder held one, the B clip's, and A was lost.
- **Fix:** detect duplicate names and refuse them, or suffix `_2` and say so. Add a test.
- **Effort:** XS.

### S4. Deadline `ExtraArguments` uses POSIX single quotes, but the plugin appends it raw to a .NET/MSVC argument string
- **Where:** farm.ts:158 (`sh(flagWords(flags))`), farm/deadline10/CorridorKey/CorridorKey.py:146-149 (`args.append(extra)`).
- **Failure:** `--hint-video '/hints/my hint.mov'` (P1b). Deadline's process launch splits on `"` and spaces, not `'`,
  so a hint path with a space breaks into two arguments. The plugin's own `quote()` exists for this.
- **Fix:** quote ExtraArguments with the plugin's rule (`list2cmdline`-style `"…"`), or better, emit `HintVideo=` and
  `Hint=` keys and let the plugin quote them. Test the split with the farm Python test harness (`test:farm`).
- **Effort:** S.

### S5. Scripts: `parseProgram` is quadratic (`lineOf` scans from 0 for every command)
- **Where:** src/shared/console/script.ts:103-108, 167.
- **Evidence:** proved (P10). 1000 pasted lines of 8 KiB took 4.4 s, and 30 000 short lines (0.3 MB) took 5.1 s, all on
  the main process. A 1 MiB `run` file (the allowed maximum) is about 1 min of frozen app.
- **Fix:** compute line starts once and binary-search them, or count lines while cutting `pieces()`.
- **Effort:** XS.

### S6. Long built-ins (`du`, `tree`, `wc`, `j`) are neither in the job slot nor cancellable
- **Where:** runner.ts:1124-1250 (and `walk`).
- **Failure:** `du` of a big share does 200 000 sequential stats, and `wc` reads up to 256 MiB. Ctrl+C does nothing
  because `cancel()` only knows `this.job`, and the line can't be stopped. Several can run at once.
- **Fix:** give the long ones a slot-free cancel token (checked per entry or chunk) that `cancel()` sets, or run them
  as a job.
- **Effort:** S.

### S7. Tests don't cover hostile input where the risk is
- farmExport.test.ts and jobCommand.test.ts use only clean names (M1, M3). Nothing tests a throw inside a program, the
  nested-loop budget, cancel during built-in loops (M4), symlinks in the export folder (M2), or that `lock-screen` fires
  on Linux (S1).
- The loop gate passes (1773 verdicts), but several verdicts state a bound the code doesn't keep: `lineOf` "NOT-WORTH"
  is quadratic, `forItems` "NOT-WORTH" overflows, and runList's "bounded: ITEMS_MAX" multiplies when nested. The gate
  checks that a verdict exists, not that it is true. That is worth a line in LOOP_PASS.
- **Effort:** comes with the fixes.

## NICE

- **N1** vars.ts:143. Inside `"…"`, `\${x}` still expands (to `\V`, P8). The doc says never after a backslash, and bash
  wouldn't expand it there. Treat `\$` in `"…"` as a literal `$`.
- **N2** expand.ts:35. `!prefix` takes `;`, `&`, `|` into the prefix (`!ren;pwd` looks for "ren;pwd", P8). Stop at the
  script separators.
- **N3** Pasted lines: the IPC checks each line has no new line, but `runLines` joins them and a `"` opened on one line
  runs into the next (script.ts `pieces`). Not a privilege issue (the dialog shows `\u{a}`), but it isn't "each line as
  a typed one". Refuse a pasted line that leaves a quote open.
- **N4** cat and head on `/proc` files (size 0) print nothing and end `done`. Read up to TEXT_MAX until EOF when
  `size === 0`, or say "empty (a special file)". Also, a stat→open race onto a FIFO would block a libuv thread: open
  with `O_NONBLOCK` and re-check with `fstat`.
- **N5** `du`: links are skipped at the top level but followed for files inside (`walk` stats through links), so sizes
  can count targets outside the folder. Use `lstat` in `walk` for du.
- **N6** `allow /` or `allow ~` passes after one click. Consider a stronger warning, or a refusal, for the root, home
  and system folders. Allowed folders loaded from settings aren't realpath-checked (shape only). Fine, but the doc's
  "nothing adds one without it" holds only for the app's own paths.
- **N7** OpenJD: extra flag words are inserted as YAML strings, and a value containing `{{` becomes an OpenJD format
  string. Escape it or refuse it.
- **N8** Flamenco: `submitter_platform: "linux"` is hard-coded. Use the exporting machine's platform, which drives
  Flamenco's path variables.
- **N9** Windows: `open`, `cd`, `j` and bookmarks accept UNC paths. stat or Show in folder on `\\host\share` sends
  NTLM credentials, so a tampered bookmark or history `cwd` can trigger it. Low; consider refusing UNC hosts not yet
  visited.

## Done well

- **Variables can't change what a line means.** Each expanded word is re-quoted, so the parser's `quoted ⇒ never a
  flag, sudo, --, command or ?` rule covers values, loop items and kept variables from settings. Proved across six
  hostile values on both platforms (P11). Expansion happens once (no re-expansion of values), after history, before
  parse, as documented.
- **Script elevation:** all destructive lines are found (including `for` and `if` bodies), they must say `sudo`, there
  is one dialog up front, it is audited before running, it never inherits or grants the session's elevation, and the
  per-job grant ends with the job.
- **History expansion is conservative:** word start only, outside quotes, not before `$F`, `####`, `%04d` or `@@@@`.
  Kept and numbered stably, with exit rows; event-not-found refuses.
- **Built-in reads are bounded:** 1 MiB windows, binary sniffing, `isFile` gates FIFOs and devices, `tree` and `du`
  don't follow directory links (no loops), and there are row, depth and entry caps.
- **Settings validation:** absolute paths, valid names, NUL-free, caps, read-only names excluded, `__proto__` excluded.
- **`allow`:** native confirmation, audited before saving, realpath'd, and the refusal text gives the exact line.
  Remove only narrows.
- **Rust `verify` ranges** are small and tested, and `-F` reads them back.
- **Docs:** the CONSOLE.md security rules are precise enough to review against. Each finding above is a place where the
  code falls short of a stated rule.

## Counts

MUST 4 · SHOULD 7 · NICE 9. Proved by run: M1, M2, M3, M4, S2, S3, S4, S5, N1, N2. Code-read: S1, S6, S7, N3-N9.

## Status (2026-10-27, branch `feat/console`)

Every MUST and SHOULD is fixed, each with tests that failed on the code before the fix (the probes became the tests);
the NICE items are backlog rows. `npm run check`, `check:engine` and `check:targets` pass.

| Finding | Done | Where |
|---|---|---|
| M1 farm export injection | control characters refused in every clip name, path, results folder, flag value and runtime path (all formats); quotes, `$`, `%`, backticks round-trip through each farm's syntax | 0853f32 |
| M2 symlinks in the export folder | each written path checked with `checkWrite`, a link at a written name refused (lstat), files written new and renamed over the name (`replaceFile`) | 39fbd06 |
| M3 "Copy as command" not shell-safe | `shellWord`: POSIX `'…'` (`'\''`), Windows `"…"` and no line for `% ! $` `` ` `` `"`; control characters give no line; read back by a real `/bin/sh` in the test | e624850 |
| M4 program robustness | built-in throws become failed blocks; the slot freed in `finally`; `for`'s cap checked before adding; one 10 000-command budget per program; a turn of the event loop before each command (Ctrl+C within 100 ms) | 3f8e088 |
| S1 no `lock-screen` on Linux | logind `LockedHint` read every 5 s while elevated (busctl, argv, no shell); where it can't be read, the window's blur drops the elevation | a940de5 |
| S2 script confirmation unfilled | lines shown with `${…}` filled in where known before they run (else said), the targets counted; a shown line runs only as shown | 67a2f91 |
| S3 two clips with one name | refused (names compared without case) | 3ac3907 |
| S4 Deadline `ExtraArguments` quoting | `list2cmdline`-style, tested against `farm/deadline10/test_quote.py`'s `msvc_argv` | b3ba6d3 |
| S5 quadratic `lineOf` | line starts once, binary search; 30 000 lines in < 500 ms (5.4 s before) | f2133a7 |
| S6 long built-ins | `du`, `tree`, `wc`, `j` take the slot (or their program's), Ctrl+C at each entry, chunk or folder | a5ce439 |
| S7 tests and loop verdicts | the tests above; untrue `[bounded: …]` verdicts corrected, a LOOP_PASS section and rule | cba3d0e |
| N1-N9 | backlog rows 131-139 (idea) | docs/BACKLOG.md |

The NICE items, 2026-10-27: N8 came with the P4 SME review's S5; the others on branch `senior-nices` (Marcy: a senior
reviewer's recommendations are implemented). Each has a test that fails on the code
before, except N6 and N9 (documented there; Marcy decided them on 2026-10-27 and they were built on branch
`senior-decisions`, with tests).

| Finding | Done | Where |
|---|---|---|
| N1 `\${x}` in `"…"` | no variable after `\$` in "…"; the backslash stays, as the Console's tokenizer reads it there (not bash's bare `$`) | 377ae79 |
| N2 `!prefix` and separators | the prefix ends at `;`, `&`, `\|` | e167b70 |
| N3 a pasted line with an open quote | refused before anything runs (`leavesQuoteOpen`, the same scan as `pieces`) | 59e8b63 |
| N4 special files | read up to TEXT_MAX when the size says 0; readRange (now files.ts) opens with O_NONBLOCK and checks fstat | 59ec9ae |
| N5 `du` through links | a link inside a folder counts its own size (lstat) | de7d7fc |
| N6 `allow /`, `allow ~` | the doc says what `allow` trusts (settings are shape-checked only); Marcy 2026-10-27: `/`, a drive's root and system folders refused (also by realpath), the home folder itself warned in the confirmation; a settings-loaded folder goes through the same refusal (dropped, audited, shown in Session) | 62613aa, 440449f, senior-decisions |
| N7 OpenJD `{{` | refused for OpenJD, naming the value | 60255c6 |
| N9 UNC paths | Marcy 2026-10-27: a network server is opened only after `allow-server <server>`, this session only, listed in Session; `doctor`'s `corridorkey info` checked too | 448f9b5, 440449f, senior-decisions |

Not tested on a real screen lock: S1's busctl read answered on this desktop (`b false`), but locking Marcy's screen to
see it turn true was not done (never her screen); the decision logic is tested with a fake reader.
