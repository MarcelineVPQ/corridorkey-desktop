# Review: the Console tab (`feat/console`, 5222b74..32b3da6), 2026-10-26

An independent senior review (Electron security, TypeScript/React, Rust). I read CLAUDE.md, docs/CONSOLE.md, docs/CLI.md,
the GUIDE section and every file in the diff. I did not read earlier reviews, bug hunts or plans. Every suspected bug
below was either **proved** with a probe (a vitest file outside the repo that drives the real `Console` class through
its injected deps, or a real run of the gate script or the CLI) or is marked **code-read**.

## Verdict

**Grade: B−. Not ready for a development release until the four MUSTs are fixed.** All four are small, under an hour
each. The architecture is right: one parser for highlighting and execution, a fixed program run with an argv, a
registry generated from the CLI's own clap tree, write checks done on the resolved path, and that resolved path being
the one passed to the CLI. The tests are broad and well aimed. But three of the MUSTs open holes in the safety
boundary the feature advertises (file scope and sudo), and the fourth makes Stop and quit do nothing on Windows, where
most users are.

Counts: **4 MUST, 8 SHOULD, 12 NICE.**

What I ran (CPU only, memory-capped, under heavy.lock):
- The branch's own tests (console*, securityGate, cliSpec, engineFind, onePageLayout): 161 passed, 1 skipped.
- The security, theme and loop gates: all pass.
- `cargo test -p ck-cli --lib spec` (built without OCIO/ORT, own target dir): passes.
- The cliSpec drift check with `CK_CLI_BIN` pointed at that binary: passes, so the checked-in cliSpec.json matches the
  branch's CLI.
- 14 review probes (appendix): all 14 reproduce the behaviours described below.
- `corridorkey render` with hyphen values, using the existing dist binary, to check how clap reads them.

I did **not** run the app in an isolated copy, because Marcy's Sonata was playing and the brief says no GPU. CSP and
keyboard notes are therefore code-read plus a scan of the built bundle.

---

## MUST

### M1. A value that looks like a URL skips the write check, for every written path

**Where:** `electron/main/console/runner.ts:392`

```ts
if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v; // ocio://… names a built-in config, not a file
if (a.writes) { … checkWrite … }
```

The `ocio://` pass-through runs **before** the `writes` branch and matches any scheme. Three consequences:
- **Windows:** `-o C://Users/Public/x/`, `--report C://…` and `--temp C://…` are real absolute paths there, so they are
  written anywhere the user can write.
- **Linux and macOS:** `-o x://y/` is written relative to the Console's folder, which `cd` can point anywhere.
- **No targets in the sudo dialog:** the value is never pushed to `targets`, so the dialog for
  `sudo render … -o x://y/ --overwrite` lists no files at all.

**Evidence:** proved (P1, three probes: Linux, Windows `C://…`, and the empty dialog targets).

**Fix:** pass a value through unchecked only when the argument is `--ocio` and the value starts with `ocio://`, and
never for an argument that writes. Add the three probes as regression tests. **Effort:** 15 min.

### M2. The `--job` file's `output_dir` / `temp_dir` check fails open

**Where:**
- `runner.ts:467-475`: `catch { return []; }`, commented "corridorkey reads it too".
- The reader in `electron/main/index.ts` (Console deps `fs.readFile`) throws on files over 1 MiB and on anything
  that isn't a regular file.

Whenever the app can't read or parse the job file, its folders are not checked at all, but the CLI can still read it
(`run.rs:148`, `read_to_string`, no size limit). A job file padded past 1 MiB with whitespace (or a FIFO) makes
`output_dir` anywhere run. A second hole is time-of-check to time-of-use: the app reads the file, then shows the sudo
dialog (which can wait indefinitely), and only then does the CLI read the file again. A changed file is never
re-checked.

**Evidence:** proved (P2: the 1 MiB file runs with `output_dir` outside the roots; the same file under 1 MiB is
refused).

**Fix:**
1. Refuse when the app can't read or parse the job file. Fail closed, not open.
2. Better: pass the job's `output_dir` and `temp_dir` to the CLI as explicit, resolved `--output` and `--temp` flags.
   Flags win over the job file (docs/CLI.md), so the CLI then uses what was checked whatever the file says later.
   Alternatively, copy the job file into the app's cache and pass the copy.

**Effort:** 30-60 min.

### M3. `render --skip-existing` replaces existing frames without sudo

**Where:**
- `src/shared/console/registry.ts:82`: `DESTRUCTIVE = { render: ["overwrite"] }`.
- `engine-rs/crates/ck-cli/src/run.rs:378-390`.

With `--skip-existing`, the CLI skips only when **every** requested frame is there and whole. Otherwise it "keys them
all again" (docs/CLI.md "Output safety"), and line 384 lifts the "already there" refusal for it. So a folder with 99 of
100 frames, or one cut frame, has all of its frames replaced, with no sudo, no dialog and no audit entry. That breaks
the documented rule that a command which replaces files runs only as `sudo`.

**Evidence:** proved on the Console side (P3: runs unelevated, no confirmation); the CLI side is code-read
(`run.rs:378-390`).

**Fix:** mark `skip-existing` destructive as well (the dialog shows the frames there now), and say so in docs/CONSOLE.md
and the GUIDE. **Effort:** 10 min plus a test.

### M4. Windows: Ctrl+C, the second Ctrl+C and quit's grace kill all do nothing

**Where:**
- `electron/main/index.ts:326`: the Console's deps pass no `killTree`.
- `runner.ts:595-601`: the fallback is `process.kill(-pid, "SIGKILL")`.

On Windows a negative pid is not a process group: Node/libuv gets ESRCH, and the runner's catch swallows it. On win32,
`cancel()` uses `killTree` for the first Ctrl+C, and `shutdown()` uses it after the 7 s grace. So on Windows the Stop
button never stops a render, and quitting leaves `corridorkey.exe` and its ffmpeg writers running and holding the GPU.
The CLI deliberately doesn't watch its parent (docs/CLI.md "No parent watch"). The tests pass only because they inject
`killTree`.

**Evidence:** proved that `process.kill(-4242, "SIGKILL")` is what runs on win32 (P5). That this does nothing on Windows
is Node's documented behaviour for negative pids there; not run on the Windows VM.

**Fix:** pass a `killTree` that does what `engine.ts:183-190` does (`taskkill /pid N /T /F`, falling back to
`child.kill()`), or make that the runner's own default on win32. Add a test that builds the Console without an
injected `killTree`, so the wiring itself is tested. Check it once on the Windows VM. **Effort:** 20 min.

---

## SHOULD

### S1. Two jobs can take the one job slot (`run` + another command at the same time)

**Where:** `runner.ts:332-343`. `script()` checks `this.job`, awaits `readFile`, then sets `this.job` without checking
again. A `render` that starts while the script file is being read is then overwritten in the slot.

What happens after that:
1. The script finishes and sets `this.job = null`.
2. Stop no longer reaches the render's child.
3. `shutdown()` doesn't stop it either (it outlives the app on Linux too).
4. A second `render` can start next to the first (two GPU jobs).

`cli()` re-checks after its awaits (`runner.ts:460`); `script()` doesn't.

**Evidence:** proved (P4: with a slow read, the render runs, the script clears the slot, `cancel()` sends no signal,
and a second render spawns).

**Fix:** take the slot before the first await (a placeholder `Job`), or check again right after `readFile`.
**Effort:** 15 min.

### S2. A command still in its checks when the app quits starts after `shutdown()`

**Where:** `runner.ts:159-179`. `shutdown()` stops only `this.job`. A `cli()` still awaiting realpath, the target
count, the dialog or the mkdir spawns afterwards, and nothing ever stops that child.

**Evidence:** proved (P11: spawned after `shutdown()` resolved, no signal sent).

**Fix:** a `closing` flag set by `shutdown()` and checked just before `spawnFn` (and before each script line).
**Effort:** 10 min.

### S3. The memory estimate isn't held off while the Console's corridorkey uses the card

**Where:** `electron/main/index.ts:959`: `estimator.ask(job.clip.path, queue.running, …)`.

`takeGpu` stops a running estimate, but a new one (for example, selecting a waiting clip on the Queue page) starts a
short-lived engine on the GPU next to a Console render. docs/CONSOLE.md says "while they run … the memory estimate
stops". That is rule 11 ("one engine at a time").

**Evidence:** code-read.

**Fix:** `queue.running || consoleGpu`. **Effort:** 5 min.

### S4. An elevated command runs even when the audit log can't record it, and the entries aren't awaited

**Where:**
- `runner.ts:438` and `runner.ts:553`: `void this.d.audit.append(...)`.
- `logs.ts:44-48`: an append error is only `console.error`'d.

"Every elevated command is logged" is promised in the dialog itself, but a full disk, a read-only userData or a
permissions problem lets elevated commands run unlogged.

**Evidence:** proved (P6: the audit file's folder is missing, the elevated render runs, the error goes only to stderr).

**Fix:** make `append` resolve to ok or failed; await the `granted` and `run` entries; refuse the elevated run when the
entry can't be written. **Effort:** 20 min.

### S5. The security gate doesn't catch the shell patterns it claims to forbid

**Where:** `.hooks/check_electron_security.sh:28-31`. Fixture runs of the real script; all of these pass (exit 0):
- `spawn(x, [], { shell: "/bin/bash" })`
- `spawn(x, [], { shell: process.platform === "win32" })`
- `spawn("/bin/sh", ["-c", line])`
- `execFile("cmd.exe", ["/d", "/s", "/c", line])`
- `const cp = await import("node:child_process"); cp.exec(line)`, and the destructured form
- `shell.openPath(p)`

The real tree also passes while `electron/main/appImageQuit.ts:72` and `electron/main/updater.ts:93` spawn shells (both
existed before this branch and are legitimate, but they show the gate checks a narrower thing than its header says).

**Evidence:** proved (fixture runs).

**Fix:**
- Match `shell\s*:` followed by anything other than `false`.
- Flag spawn or execFile of `sh|bash|zsh|cmd(.exe)?|powershell|pwsh`, with an explicit `// gate: shell-ok — why`
  marker for the two existing uses.
- Forbid `import("…child_process")`.
- Add the cases to `tests/unit/securityGate.test.ts`.

**Effort:** 30 min.

### S6. Windows: the CLI's DLL search order includes the Console's folder

**Where:** `runner.ts:548`: `cwd: this.cwd`, a folder `cd` can set to anywhere (Downloads, a client's drive).

On Windows, the standard DLL search order searches the current directory before PATH. Any DLL that corridorkey.exe,
ONNX Runtime or the CUDA/TensorRT provider loads by bare name, and that isn't next to the exe or provider (CUDA, cuDNN
and TensorRT DLLs are commonly on PATH), is loaded from the Console's folder first. That is code loading from a folder
the user merely visited. Rust's `Command::new` no longer searches the current directory, but `LoadLibrary` does.

**Evidence:** code-read; not verified on the VM.

**Fix:**
- In `ck-cli` main on Windows, call `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS | LOAD_LIBRARY_SEARCH_USER_DIRS)`
  plus `AddDllDirectory` for the ORT folder, or at least `SetDllDirectoryW(L"")`. This also protects farm use.
- Or spawn with a fixed cwd (the app's cache) and pass every path absolute.

**Effort:** 30 min plus a VM check.

### S7. The sudo dialog's command text is not an honest, unambiguous rendering

**Where:** `runner.ts:436`, `index.ts` `confirmElevation`.
- `argv.slice(1).join(" ")` without quoting, so paths with spaces read ambiguously.
- It includes the Console's own `--temp …/console --progress-format json`.
- Control characters and bidi overrides in a path are shown raw (a crafted name can add fake lines to the dialog).
- The target count walks the **whole** output folder recursively, not the frames at the run's names, so it overstates
  what will be replaced.
- After M1 it can also be empty.

**Evidence:** code-read (the empty case proved in P1).

**Fix:** show the line as typed plus a quoted argv (`quoteArg`), escape control and bidi characters, leave out the
Console's own flags, and count only the names the run will write (the folder layout and pattern are known:
`<clip>_<output>_exr/…`). **Effort:** 1 h.

### S8. `role="log"` covers the whole output, including streaming lines and 5000-row tables

**Where:** `src/ui/pages/ConsolePage.tsx:126`. A log role is an implicit polite live region: every appended span (up to
10 pushes a second during a verbose render) and every `dir` row is queued for announcement. The output becomes unusable
with a screen reader, which defeats the a11y work elsewhere on the page.

**Evidence:** code-read (ARIA semantics).

**Fix:** make the output container a plain region. Add one small `role="status"` that announces block state changes
("render: done, exit 0"; "refused: …"). **Effort:** 30 min.

---

## NICE

| # | Where | Issue | Fix |
|---|---|---|---|
| N1 | `runner.ts:415` | Values go to the CLI as `--flag value`. A value starting with `-` (`--codec=-x`, `--hint=-q.png`) passes the Console's parser, then clap reads it as a flag (exit 2). Not an injection: I checked with the binary that clap rejects it. It is a parity gap (P7). | Emit `--flag=value` (and `-- ` for positionals, as now). |
| N2 | `runner.ts:434` | `sudo` on a non-destructive command is silently ignored (P8). | One info line: "sudo isn't needed for this; ran it normally". |
| N3 | `paths.ts:20,51` | Case folding is decided by platform, not by volume. On a case-sensitive APFS volume (or a Windows per-directory case-sensitive folder), a **missing** `…/results/new` passes as inside root `…/Results` (P9). | Fold only the part realpath returned. Compare the missing tail case-sensitively, or realpath the root and check `relative()` on the real prefix. |
| N4 | `paths.ts`, CLI `run.rs:340-349` | Only the given path is resolved. The CLI's derived paths inside it (`<clip>_alpha_exr/`, the settings file) follow an existing symlink in a chosen folder out of it. A missing tail checked now can be a symlink by the time the CLI writes (TOCTOU). Low risk (the user's own folders), but the scope claim is absolute. | Document the limit, or have the CLI refuse a symlinked target subfolder (`symlink_metadata`). |
| N5 | runner `script()` | A `run` script inherits an active elevation: an untrusted `.ckcmd` run within 5 min of a sudo replaces files with no dialog. | Scripts never use an existing elevation: one dialog per script, listing its destructive lines. |
| N6 | `OutputBlock.tsx:84`, `push.ts` | `key={i}`: once lines are dropped from the front, every key shifts and all 2000 spans re-render on each push. Every push resends the whole block (≤ 2000 × 4000 chars). The renderer keeps 200 such blocks (worst case GBs). | Key by `linesDropped + i`; push appended lines only; cap total kept characters. |
| N7 | `LineEditor.tsx:252` | `aria-controls` names the list's id while the list isn't rendered (an ARIA reference to nothing). | Set it only when the list is shown. |
| N8 | `editor.ts:386` | On macOS, Alt+F and Alt+B produce `ƒ` and `∫` as `key`, so the word moves don't work and insert characters. | Use `e.code` (`KeyF`, `KeyB`) for Alt combinations. |
| N9 | `index.ts:365`, registry `GPU` | `takeGpu` doesn't wait for the paused prebuild's or the stopped estimate's engine to exit (the bug hunt P6 pattern), so the CLI's automatic window can see their memory. `info` (initialises CUDA) isn't gated at all. | Wait for those engines to end (as `queue.engineEnding`); treat `info` like `verify` but refuse it while the queue runs, or document. |
| N10 | `tests/unit/cliSpec.test.ts`, `tools/gen_cli_spec.mjs` | A `CK_CLI_BIN` that doesn't exist, or no binary with `__spec` (true today in the main checkout's targets), silently skips the drift check. Only macOS CI exists, so the drift check runs nowhere by default. | Fail when `CK_CLI_BIN` is set but missing; have `npm run check` say loudly that the drift check was skipped. |
| N11 | `complete.ts`, `cd`, `dir` | No deadline on readdir or stat: Tab or `dir` on a hung network share leaves the request pending (the page shows nothing). | A timeout per request (e.g. 3 s) with a "folder didn't answer" item. |
| N12 | the app has no `Menu.setApplicationMenu` | Electron's default menu keeps Ctrl+R (reload), Ctrl+W (close) and Ctrl+Shift+I. The editor calls `preventDefault` synchronously for its keys, which on Linux and Windows keeps them from the menu, but I couldn't confirm it in a running copy (no isolated run: Sonata was playing, no GPU). | Check once in `tools/isolated.sh`: Ctrl+R and Ctrl+W in the input, with the page not reloading or closing. |

---

## What is done well

- **Never a shell, structurally:** `spawn(bin, argv, { shell: false })` of one binary found by `findCli`. Positionals
  go after `--`. Unknown flags are refused by the Console's parser before the CLI sees them. `--progress-format` is
  refused and set by the Console. No eval anywhere, and the built bundle has no `new Function`, `eval` or inline styles.
- **One parser, real parity:** the page and the main process use the same `parse()` with the same registry and the
  same platform switch. The main process re-parses and re-checks everything. The registry comes from clap itself via
  `__spec` (unit-tested in Rust; the drift check passes with the branch binary).
- **Resolve-then-pass:** the write check resolves with realpath (the missing tail through the nearest real parent), and
  the **resolved** path is what the CLI gets, which closes the usual check-one-path, use-another bug for `-o`,
  `--report` and `--temp`. Symlink escapes and `..` are tested with real files.
- **IPC hygiene:** sender and main-frame check on every Console channel; typed, bounded arguments (8 KiB line, no NUL,
  cursor range); the preload exposes named functions only.
- **Elevation model:** memory-only state, TTL plus a hard cap, dropped on blur, `sudo -k`, the panel and quit; the
  dialog runs in the main process with Cancel as the default. The renderer has no way to grant it.
- **Runner:** own process group on Unix; SIGTERM then group SIGKILL; the quit grace; GPU interlocks with the queue and
  the prebuild; output capped per block (2000 lines × 4000 chars); throttled pushes only while shown; the CLI's exit
  codes shown with their meaning; progress only from the CLI's events (rule 1).
- **CSP tightened properly:** `style-src` without `unsafe-inline` (React's style props go through CSSOM, so they keep
  working), `connect-src 'none'`, and media, frames and workers off. The gate now checks the CSP's presence and that it
  isn't loosened.
- **Parser robustness:** never throws; error ranges in UTF-16 indices; unterminated quotes; Windows backslash rules.
  An 8 KiB line parses in ≤ 2.6 ms (P10).
- **UI rules:** the one-accordion panel (`Accordion`/`Section`), theme tokens only (the gate passes), loop verdicts
  everywhere (the gate passes), a combobox with `aria-activedescendant`, and a Re-run that never runs by itself.

## Tests: do they prove the claims?

They prove most of what docs/CONSOLE.md claims, with a fake spawn and real files. The gaps are exactly the MUSTs and
SHOULDs above:
- The Windows kill path is mocked away (M4).
- Scheme-looking values are tested only for reads (M1).
- The job file is tested only when it is readable (M2).
- `--skip-existing` is untested (M3).
- No concurrency test for `run` + a command (S1), or for quit during the checks (S2).
- Audit failure is untested (S4).
- The gate's fixtures don't cover string or expression `shell:` values, `sh -c`, or dynamic imports (S5).

Each probe in the appendix can become a regression test with its assertion inverted.

---

## Appendix: the probes

Run from a scratch folder (outside the repo), with a vitest config whose `include` is `probe/**/*.test.ts` and
`node_modules` linked. Each test **passes when the bug is present**.

```ts
// P1: linux
await c.run("render shot.mov -o x://y/");                          // state "running", argv has "x://y/" (cwd outside roots)
// P1: win32 (paths.platform "win32", roots ["D:\\results"])
await c.run("render shot.mov -o C://Users/Public/anywhere/ --report C://Windows/Temp/r.json"); // runs, both unchecked
// P1: dialog
await c.run("sudo render shot.mov -o x://y/ --overwrite");         // confirm() gets targets: []
// P2: job file padded past 1 MiB with output_dir outside the roots (index.ts's readFile semantics)
await c.run(`render --job ${big}`);                                // runs; the same file under 1 MiB is refused
// P3
await c.run("render shot.mov -o ../out/ --skip-existing");         // runs, elevated false, no confirm
// P4: readFile gated (slow disk)
const script = c.run("run s.ckcmd"); await c.run("render shot.mov -o ../out/a/"); release(); await script;
c.session().running === null; c.cancel();                          // render child got no signal; a 2nd render spawns
// P5: win32, no killTree injected, process.kill spied
c.cancel();                                                        // process.kill(-4242, "SIGKILL")
// P6: AuditLog in a missing folder
await c.run("sudo render shot.mov -o ../out/z/ --overwrite");      // runs elevated; only console.error
// P7
await c.run("render shot.mov -o ../out/c/ --codec=-x");            // argv "--codec", "-x"; clap: exit 2
// P8
await c.run("sudo render shot.mov -o ../out/d/");                  // runs, elevated false, nothing said
// P9: platform "darwin" on a case-sensitive fs, root <tmp>/Results exists
await checkWrite(`${tmp}/results/new`, tmp, [`${tmp}/Results`], deps); // ok: true
// P10: parse() of four 8 KiB lines: 0.15-2.55 ms each
// P11
const pending = c.run("render shot.mov -o ../out/q/"); await c.shutdown(50); await pending; // spawned after shutdown
```

Gate fixtures (S5), each run as `bash .hooks/check_electron_security.sh <fixture>`, all exit 0:
`shell: "/bin/bash"`, `shell: process.platform === "win32"`, `spawn("/bin/sh", ["-c", line])`,
`execFile("cmd.exe", ["/d","/s","/c", line])`, `await import("node:child_process")` (plain and destructured),
`shell.openPath(p)`.

---

## Status (2026-10-26, `feat/console`)

Marcy approved all MUSTs and SHOULDs; the NICE items are backlog rows. Each fix has a test that failed on the old
code; each probe is a regression test (P7-P9 pin the open rows' behaviour today: flip them when the row is built).

| Finding | Done in | Test |
|---|---|---|
| M1 URL-looking values skip the write check | e95057f | P1 ×3 (`consoleRunner.test.ts` "review 2026-10-26 probes") |
| M2 `--job` check fails open, TOCTOU | 0a0a73b: refused unless read and parsed; its folders passed as resolved `--output` / `--temp` | P2 ×2 |
| M3 `--skip-existing` replaces without sudo | 3bacde9: destructive | P3 |
| M4 no kill on Windows | 7fa5755: the runner's win32 default is `taskkill /T /F` (System32, full path) | P5 (built without an injected `killTree`); not run on the Windows VM (no other machines in this pass) |
| S1 two jobs in the one slot | a8143fa: `run` takes the slot before any await | P4 |
| S2 spawn after `shutdown()` | a8143fa: nothing spawns once quitting | P11 |
| S3 estimate beside a Console render | 202aa31: `queue.running \|\| consoleGpu` | wiring test in `estimate.test.ts` (index.ts needs Electron) |
| S4 elevated runs unlogged | ebcba7d: `append` resolves ok/failed; `granted` and `run` awaited, refused when unwritten | P6 ×2, `consoleSafety.test.ts` |
| S5 gate misses shells | 394902d: `shell:` ≠ false, shells by name, `-c` / `/c` / `-Command`, `import()`, `shell.openPath`; `gate: shell-ok — why` for the five reviewed uses | the review's gate fixtures in `securityGate.test.ts` |
| S6 Windows DLL search in the Console's folder | 2382ea9: ck-cli's main calls `SetDllDirectoryW("")` | evidence: Microsoft's documented behaviour of an empty SetDllDirectory; `npm run check:targets` lints it for Windows; not run on the VM. Not covered: ffmpeg processes the CLI starts still inherit the Console's folder as theirs |
| S7 the sudo dialog | 26367a5: typed line + quoted argv without the Console's flags, control/bidi escaped, only the run's names counted | S7 tests |
| S8 `role="log"` | 95829b7: plain region + one polite `role="status"` | `consoleBlocks.test.ts` |
| P10 parse speed | — | `consoleParse.test.ts` (< 100 ms per 8 KiB line) |
| N1-N12 | docs/BACKLOG.md rows 106-117 (idea) | P7 → row 106, P8 → row 107, P9 → row 108 |

The NICE items, 2026-10-27: N2, N5 and N8 came with the SME review's S11 and S10; the others on branch `senior-nices`
(Marcy: a senior reviewer's recommendations are implemented).

| Finding | Done in | Test |
|---|---|---|
| N1 a value starting with `-` | 7026f2b: such a value goes as `--flag=value`; other values stay two words | P7 flipped |
| N3 case folding per volume | 9bc433b: only the names realpath returned fold, a missing tail compares as typed | P9 flipped, plus a case-insensitive volume |
| N4 derived paths and symlinks | 637dcf0: documented (docs/CONSOLE.md file scope); decided: the CLI keeps following a symlinked subfolder, studios use symlinked show folders (Marcy 2026-10-27, row 109) | none (a doc) |
| N6 output memory | b12f3a3: lines keyed by number, pushes carry appended lines (`linesFrom`), 256 000 characters per block | the push/merge round trip, the character cap |
| N7 `aria-controls` to nothing | 8874b10 | the editor rendered without its list |
| N9 wait for the engines it stops | c95e8d7: takeGpu waits (≤ 5 s) for the estimate's and the build's engines, the slot checked again after; `info` refused while the queue runs | engineEnding (estimate, build), untilEnded, info, a slot taken during the wait |
| N10 cliSpec drift check | 5b2c723: a bad `CK_CLI_BIN` throws; `npm run check` ends with a loud SKIPPED banner | both bad `CK_CLI_BIN`s |
| N11 deadlines for Tab and dir | 71cd2a8: readdir / stat / lstat / realpath answer within 3 s | dir, cd and Tab on a share that never answers |
| N12 Ctrl+R / Ctrl+W vs the menu | 6e0a5ce: the editor half (handled in every state); 440449f (Marcy 2026-10-27): a shipped copy has no developer tools and no default reload/close shortcuts, `npm run dev` keeps them; the real-window check in `tools/isolated.sh` runs separately | `consoleEditor.test.ts`, `appMenu.test.ts` |
