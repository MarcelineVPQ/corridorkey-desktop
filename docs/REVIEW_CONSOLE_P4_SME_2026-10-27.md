# Console Phase 4: SME review (CLI veteran + VFX pipeline TD), 2026-10-27

Branch `feat/console` at a751945. Read: docs/CONSOLE.md, docs/GUIDE.md "Console", docs/CLI.md, farm/README.md,
`src/shared/console/*`, `electron/main/console/{runner,farm}.ts`, the p4a/p4b screenshots. Probed: the runner with the
repo's own fake-spawn harness (a copy of `consoleRunner.test.ts`'s `make()` in scratch), `farmExport()` for all five
formats on two realistic clips, and `groupSequences()` on edge-case folders. No GPU, no app window, no code edited.

## Verdict

**Adopt: yes for artists, after three fixes for pipeline.** A lighting TD or comp lead would use this daily: it
reads a plate folder the way `lsseq` does, never misreads `$F4` / `%04d` / `####` / `@@@@`, every refusal ends with
the exact line to type, and the queue echoing its own `corridorkey render` line is how people learn a CLI. A pipeline
TD would adopt farm export **once the farm frames land where the GUI's frames land** and the frame range can't be
silently short. Variables plus globs is the first loop anyone writes, and right now it quietly does nothing.

**Grade: B+.** The interactive console is A-. The script language is B (sound, small, but one silent footgun). Farm
export is B-: the files are close to submit-ready, but no wrangler would accept them as-is (no pool or group, this
desktop's `$HOME` paths, a different output layout than the GUI).

Counts: **3 MUST · 10 SHOULD · 12 NICE.**

---

## MUST

**M1. Farm frames land under different names than the GUI's frames.** `farm.ts` `pattern()` and every format.
- *What a user hits:* the queue (and Copy as command, `jobArgs`) renders `-o <results>` as a folder, so the frames
  are `key/sh010_alpha_exr/sh010_alpha.1001.exr`. Farm export renders `-o <results>/sh010.####.exr`, so the frames
  are `key/sh010_alpha.1001.exr`. Same clip, same results folder, two layouts. The comp's Nuke Read nodes, built
  from the GUI's look-dev pass, don't see the farm's final frames, and both copies sit side by side on the share.
  Deadline's `OutputFilename0=sh010.####.exr` and OpenJD's / Flamenco's output point at a name **no file has** when
  there are several outputs (the CLI adds `_alpha`/`_fg`), so the Monitor's "View Output" opens nothing. (Probe:
  `alpha,fg` gives `OutputFilename0=sh010_plate.####.exr`, but the files are `sh010_plate_alpha.####.exr`.)
- *Fix:* the farm passes the same `-o <folder>` the queue does (verify takes render's arguments, so the Verify steps
  work unchanged), and each format names the real per-output paths: Deadline `OutputDirectory0/1` +
  `OutputFilename0/1` per output, the OpenJD `OutputPattern` dropped for a folder. One test: for a job, the paths
  the farm files name equal the paths the queue's run writes.

**M2. A frame folder's range can be silently short in Deadline and OpenCue exports.** `runner.ts` `shotRange()` →
`groupSequences(...).sequences[0]`; `sequences.ts` groups by digit **count**.
- *What a user hits:* unpadded frames (`frame.1.exr … frame.120.exr`) group as three sequences (`#` 1-9, `##` 10-99,
  `###` 100-120); a sim or a long shot past 9999 (`sim.9997 … sim.10002`) as two (probe output). `sequences[0]` is
  then the shot's range: the Deadline job says `Frames=1-9`, runs `-s 1 -e 9`, keys 9 of 120 frames and **ends
  green**. `dir` shows the same split, which is how the TD would notice, if they looked.
- *Fix:* group like `lsseq` and ck-cli's `frame_of`: an unpadded run and a run that only overflows its padding are
  one sequence. `shotRange` takes the clip's first and last frame from all of its frames (or asks the CLI, which
  reads the folder for real), and refuses an export when the folder holds more than one sequence. Tests: both
  probe folders.

**M3. A variable in a `for` word turns off its pattern, silently.** `vars.ts` `expandVars` quotes the whole word;
`runner.ts` `forItems` skips globs and frame patterns on a quoted word.
- *What a user hits:* the docs' own style, `set -p show=/mnt/show`, then
  `for f in ${show}/sh010/plates/*.exr; do …; done` runs **once**, with `f` = the literal `/mnt/show/…/*.exr`, and
  ends `done` (probe: `for f in ${od}/sh010/key.####.exr` echoes the pattern itself, once). Typed without the
  variable, the same loop works. "A pattern that matches nothing is an error" doesn't apply, because the pattern is
  never tried. Nobody will guess that the `*` they typed is quoted.
- *Fix:* keep the rule that a **value** is never a pattern, but quote only the value, not what was typed around it.
  When a `for` word is filled in, the value's own `* ? [` and frame-token characters are escaped, and the typed
  `*.exr` / `####` still count. Tests: `${dir}/*.exr`, `${dir}/x.####.exr`, and a value that contains `*`, which
  stays literal.

---

## SHOULD

**S1. `ls` / `dir` take no pattern, and `ls -lh` is refused.** Probe: `ls *.exr` gives "… isn't there"; `ls -lh`
gives "'-lh': only switches combine in one word". COMMAND.COM's `dir *.exr` and Unix's `ls *.exr` / `ls -lh` /
`ls -ltrh` are muscle memory from 1985 on. *Fix:* `dir` filters by a file-name pattern (the `for` glob code
already exists). In `ls`, `-h` means human sizes, as GNU does: sizes are already human, so take it and ignore it.

**S2. Copy as command doesn't run in a terminal.** `jobCommand.ts` `jobArgs` has no runtime, and ck-cli has no
fallback to the app's models or ONNX Runtime (CLI.md: `--models` / `CK_ENGINE_MODELS`, `--ort` / `CK_ENGINE_ORT`
only; doctor shows "pass --ort"). The docs say the line "is pasted into terminals too", but pasted, it fails on the
runtime. *Fix:* either the CLI falls back to the app's own install when it runs from it (best: the line stays
short), or the copied line carries `--models … --ort …`. Doctor could add a row: "a terminal needs …".

**S3. Every farm job carries this desktop's runtime paths.** `farm.ts` `runtimeWords(env)`. Probe: OpenJD
`parameter_values.yaml`, the OpenCue script, the Flamenco JSON and `run-shots.sh` all hold
`/home/<user>/.local/share/corridorkey-desktop/...`. The note says "change them", which means a sed over 40 files per
export. *Fix:* `farm export … --models <worker path> --ort <worker path>`, or kept variables
(`set -p farm_models=…`) that the export reads, and leave them out when they aren't set. Deadline already does this
right: its paths live in the plugin's config.

**S4. The Deadline export is thinner than a wrangler expects.** `farm.ts` `deadline()`. There is no Verify job,
although farm/README.md describes one and OpenJD, OpenCue and Flamenco all have one. There is no
`Pool`/`Group`/`Priority`/`Comment`/`BatchName`/`Department`, and Deadline has no GPU host requirement, so without a
`Group` the job can land on a CPU-only render node and fail there. Forty shots show up as forty unrelated jobs.
*Fix:* write a `<clip>_verify_job_info.txt` with `JobDependencies` (a submit script, or `deadlinecommand -SubmitMultipleJobs -dependent`),
`BatchName=<export folder name>`, and `Pool`/`Group`/`Priority` from flags or kept variables (empty means the
repository's default, said in the notes).

**S5. Flamenco: hard-coded `submitter_platform: "linux"`; and the frames-already-there policy differs by format
without saying so.** On Windows, Flamenco's two-way variables translate paths by the submitter's platform, so a
Windows desktop's export maps wrong. On "frames already there", Deadline and OpenCue always `--overwrite`, OpenJD
defaults to `--skip-existing`, Flamenco is `refuse` (exit 4 on a resubmit) and shell uses `--skip-existing`. *Fix:*
take the platform from `process.platform`. Pick one policy per export (a flag, default the same everywhere) and print
it in the block's notes: "these jobs replace frames at …".

**S6. Shell export: the shot lists clobber each other's logs, and one failure stops the rest.** `farm.ts` `shell()`
runs every list with the same `--logs "$here/logs"`. `corridorkey-farm.sh` names logs `shot-N.*` from 0 for each
list and starts with `rm -f "$logs"/shot-*.exit`, so list 2 overwrites list 1's logs, reports and exit codes. The
lists are joined with `&&`, so a single failed shot in list 1 skips every shot in list 2, and the lists run one after
another, so a two-card box idles. *Fix:* `--logs "$here/logs/<list>"`, `;` with a summed exit status, and `--gpus`
written in when known.

**S7. OpenJD: a frame-folder clip goes in as `Input` with `objectType: FILE`.** `parameter_values.yaml` gives the
folder (probe: `value: "/mnt/show/…/plates/sh010_plate"`). `openjd check` doesn't look, but Deadline Cloud's
job-attachment upload reads `objectType`, and a folder declared as a FILE (or a `####` pattern) is the combination
farm/README.md already lists as unchecked. *Fix:* a DIRECTORY-input variant of the template for frame folders. Until
someone tests it on Deadline Cloud, the export's note should say so. (Unverified: no Deadline Cloud account here.)

**S8. A loop's output is mostly chrome.** Screenshot `for-sequence.png`: every iteration is a full block with a
header, the state, the exit code, the time, three buttons and a "from echo ${f}" line, about 100 px for one line of
output. A 40-shot nightly is a wall. *Fix:* a program's child blocks collapse to one row each (✓/✗, the line, the
time, the last output line) and expand on click. The failed child opens on its own.

**S9. In the iteration loop, sudo is a tax.** The model itself is right: read anywhere, write only where allowed,
destructive means sudo, the audit log is append-only. That is the strongest safety story I've seen in a DCC
console. But look-dev is "render sh010 over the last try" twenty times a day, and that means a dialog at least every
15 minutes. Studios don't solve this with overwrite permission. They solve it with versions. *Fix (a complement, not
a change to the decided model):* an output token for the next free version, `-o key/sh010_v###/`, which picks
`v004` when `v003` exists. It replaces nothing, so no sudo, and it is how every show's publish works. `${status}`
and `history` already make "which version was good" findable.

**S10. No list variable, and no loop over a shot list.** `set shots="sh010 sh020"` followed by
`for s in ${shots}` runs once, with `s` = `"sh010 sh020"` (probe). That is zsh's rule, and safe, but nothing says
so, and there is no other way to keep a list. A TD's first loop reads a shot list from a file. *Fix:* `for s in
@lines shots.txt` (one item per non-comment line, the 10 000 cap applies), or a `for` that warns when one item has a
space and came from a variable.

---

## NICE

- **N1.** `ANSWERS` for more reflexes: `export X=1` / `X=1` / `setenv` / `$env:X=` → "the Console's variables are
  `set X=1`, `${X}`"; `lsseq` → `dir`; `grep` → `history <term>`, `help -k`; `echo $HOME` → a hint that only
  `${home}` expands (it prints `$HOME` today, correct but surprising).
- **N2.** `set a=1 b` sets `a`, then fails on `b`, and the block says failed (probe). Make it all or nothing.
- **N3.** "1 files (86 B)" (`dir-polished.png`).
- **N4.** The echoed queue line wraps inside a flag (`--` / `codec` on two lines, `console-gui-job-echoed.png`).
  Break only at spaces.
- **N5.** `dir` truncates the gaps (`missing 1012-1015, 1…`). Show the count of missing frames on the row
  (`43/48 frames`); the full gaps are on hover.
- **N6.** An EXR header look: `dir -l` (or `info <plate>`) shows resolution, channels, compression, pixel type and
  data window of a sequence's first frame. It's the first question about any plate ("is this the 4K one? does it
  have alpha?"), and today it means leaving for `exrheader`.
- **N7.** A **Re-render missing** action on a failed `verify` block that types `render … -F <ranges>` (the ranges are
  already there).
- **N8.** **Copy as Nuke Read** on a finished render: the `Read { file …%04d.exr first … last … }` snippet. It's the
  comp lead's actual next step.
- **N9.** Negative frame numbers (`sim.-010.exr`, Houdini pre-roll) aren't a sequence.
- **N10.** The `j` scores (`24.00`) are noise. zoxide shows them, but a rank column (1, 2, 3) reads faster.
- **N11.** `farm export` notes say `<clip>`. Print each clip's exact submit line (`deadline bundle submit
  …/sh010_plate`, `deadlinecommand …`) so it can be pasted.
- **N12.** `.ckcmd` scripts run only inside the app. A `corridorkey run nightly.ckcmd` (headless, the same parser
  and rules) would let the same script run from cron or as a farm pre-job.

---

## First week: a lighting TD on a show

**Mon.** She opens Console, types `ls -lh` and gets refused for `-h` (S1); `ls -l` works. `dir plates` shows
`sh010_plate.####.exr 1001-1048 · 43 frames · missing 1012-1015…`, which is better than her `lsseq` alias. She
`bookmark`s three shots. `doctor` tells her that her ORT runtime isn't loaded and exactly where to click. She trusts
it from then on.

**Tue.** She queues sh010 in the GUI, sees the `corridorkey render …` line appear, clicks Copy as command, and pastes
it into Konsole for a quick test: it fails on the runtime (S2). Back in the Console, `^sh010^sh020` re-runs it for
sh020. `j sh02` takes her there. This is the moment she's sold.

**Wed.** Look-dev. She renders over her last try: refused, "type `sudo !!`". She does, and likes that the dialog
names the 48 files it replaces. By the afternoon she's seen the dialog a dozen times and starts writing to new
folders by hand (S9).

**Thu.** The nightly. She writes `set -p show=/mnt/show/sq01` and `for f in ${show}/*/plates; …`, which runs once
on the literal string and says done (M3). She retypes it without the variable and it works. Then
`for s in sh010 sh020 sh030; do cd @${s} && render …; done` gives 30 blocks of chrome (S8).

**Fri.** The sequence goes to the farm: `farm export deadline --queue -o @farm`. The wrangler opens the job files:
no group, so it would land on CPU nodes (S4). The comp lead's Read nodes point at `sh010_alpha_exr/`, but the farm
writes `sh010_alpha.####.exr` next to it (M1). One shot from an outsourced vendor has unpadded frames and comes back
"complete" with 9 frames (M2). The pipeline TD says "fix these three and we'll put it in the show's tooling."

---

## Done well

- **Sequences are first-class and literal.** One item everywhere (`dir`, `open`, `cd`, `for`, Tab), the four frame
  tokens never expand, and `!` / `$F` / `@@@@` stay safe from history and variables. That is the hardest part of a
  console for VFX, and it's right.
- **Teach by echo.** The queue's exact line, shell-safe quoting (Windows refusing what cmd/PowerShell would read),
  and a test that parses it back into the engine's options. That is how a GUI user becomes a CLI user.
- **Errors you can act on.** Every refusal names the cause and the line to type (`allow "/mnt/show/sq01"`,
  `sudo !!`, `-F 1012-1015,1040`). There's no `ENOENT` anywhere, and `rm` / `exit` / `less` get straight answers.
- **verify → requeue ranges.** The `missing frames: … (re-render them: -F …)` line is exactly what a wrangler wants.
- **The safety model.** Read anywhere, write where allowed, sudo for replacement with the real targets and byte
  counts, an append-only audit, scripts confirmed up front as one dialog. On Linux, the screen-lock drop through
  logind is a thoughtful touch.
- **Farm files written defensively.** Control characters refused, case-insensitive name clashes refused, MSVC
  quoting for Deadline, links never written through. farm/README.md is honest about what was and wasn't run on a
  real scheduler.
- **The script language's scope.** `; && || for if time`, `set -e` semantics for scripts but not typed lines, and
  parse errors before anything runs. Small, predictable, and no pipes was the right call for now.
- **doctor.** One table, ✓/⚠/✗, a fix under each problem, and exit 1 so a script can gate on it.

## After this phase

1. M1-M3, with probes as tests (all three are small).
2. Farm export for a real wrangler: worker paths (S3), Deadline batch/group/verify (S4), one replace policy across
   formats (S5), shell log fix (S6). Then the first real scheduler run: a Deadline 10 repository in a VM, which is
   cheaper than any amount of stub testing.
3. Next-version outputs (S9) and the collapsed program view (S8). Together they make the nightly loop pleasant.
4. EXR header look (N6), Re-render missing (N7), Copy as Nuke Read (N8): the comp lead's week.
5. Then the deferred list, in this order: `watch` (a folder or a verify, for dailies), then `jobs`. Pipes last, and
   maybe never: the block model plus Copy output covers most of what people pipe to.
