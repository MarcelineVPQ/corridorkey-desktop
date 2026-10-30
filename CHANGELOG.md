# Changelog

## 1.0.0-dev.7 (draft, unreleased)

- **One TensorRT build per size now covers your card.** A build used to size itself from the graphics memory free at
  that moment, so a size built while another program used the card covered only short windows, and later clips of
  that size ran on CUDA. Each build now covers every window a job of that size can pick on your card, worked out from
  the card's total memory: the same every time on one card, and more on a card with more memory (on fake 16 GB and
  32 GB cards in the tests: HD up to 24 and 56 frames, 4K up to 8 and 16). A job now uses a size's engines at any
  window up to the one they were built for. Sizes built by an earlier version keep working where their window
  reaches; for the rest, see the next point. TensorRT is on Linux today, Windows coming.
- **A clip that ran without TensorRT offers to build it.** When no TensorRT engine fits a clip, its page now says
  "not built for this clip's size yet, so this run used CUDA" with a **Build it now** button: one click starts the
  same background build Engine settings, TensorRT runs, for that clip's size, with how long it took on this card
  when the app has measured it. The next run of the clip uses it.
- **The app no longer lists itself as another program using the graphics card.** The notice showed CorridorKey's own
  graphics process ("corridorkey-desktop — 0.6 GiB"); the app's own processes are now left out, by process ID.

## 1.0.0-dev.6

- **TensorRT no longer says "built" for engines it can't use.** Engine settings, TensorRT called a size built whenever
  its engine files were there, but the engine only uses engines built from the model files it runs with now. TensorRT
  engines built before the model set changed (from 2.0.0-onnx.4's files, now running 2.0.0-onnx.5) showed as built
  while every job of that size said "TensorRT for this resolution range isn't built yet" and ran on CUDA. The app now
  decides "built" exactly as the engine does, so such a size says **built for other models · needs a rebuild (the
  model set changed)**, and its tick or Build now rebuilds it: rebuild the size once and its clips run on TensorRT
  again.

## 1.0.0-dev.5

- **Faster keying, the same mattes.** The engine keeps the graphics card busier and copies less: a clip's first frames
  decode while the models load; in the normal mode on CUDA with the automatic window and at least 10 GB for the job, three of the five models
  load while the first pass runs; in the normal mode each temporal window's results are blended while the card already
  works on the next window, and C-RADIO and MoGe run once per frame instead of once per window a frame is in (CUDA and
  CPU); the networks' results are read where ONNX Runtime made them instead of being copied out; in the normal mode
  stage 2 reuses stage 1's already converted frames; and the first pass resizes its inputs without a full-size copy.
  On the RTX 5080 (CUDA fp16, model set 2.0.0-onnx.5, the automatic window, alpha and foreground as float EXR), against
  dev.4, the median of three alternating runs each: the 4K EXR shot 04_5h (4096×2160, 120 frames, 8/4 normal mode)
  keys in 152.5 s instead of 165.7 s (**−8.0 %**), the HD clip walking_sitting (1280×1080, 314 frames, 48/24
  low-memory mode) in 56.0 s instead of 57.6 s (**−2.8 %**). Every output file of those runs is byte for byte dev.4's
  (`cmp`). That is what was checked: the RTX 5080 only, those two windows, float EXR; other cards, other windows, the
  CPU provider and Core ML were not compared with dev.4. The timing runs used the build before the last change (the
  resize); the final build was checked byte for byte against dev.4 in one run at HD and, before the last load-order
  fixes, one at 4K; not timed. TensorRT (on Linux today, Windows coming): not measured. The cost, at the 4K peak on
  the RTX 5080: 0.27 GB more graphics memory (11.08 → 11.35 GB) and about 0.9 GB more RAM (7.8 → 8.6-8.7 GB); with
  less than 10 GB for the job (an 8 GB card) the models load as in dev.4, and the graphics-memory cost there is not
  measured. On the Mac mini M6 (16 GB), a 12-frame 1920×1080 Core ML job peaked at 2.74 GB (one run; dev.4 wasn't
  measured there). Windows' memory: not measured. In the normal mode a job that is stopped or fails part-way writes
  one window's frames fewer than dev.4 did (backlog row 182; docs/ENGINE_RUST.md, "The pipelining pass").

- **The README is a short page for artists:** what the app is, how to start, what your computer needs, and the
  highlights; the speed tables, test machines, methods and "what we got wrong" moved, word for word, to
  [ENGINEERING.md](ENGINEERING.md) (backlog row 181). The Windows notes now include Edge's "isn't commonly downloaded"
  warning and how to keep the installer.

## 1.0.0-dev.4

- Windows and macOS: the app now tells you when a new version is out, like on Linux: the same signed check, channels
  and "1.0.0 Dev N is available" notice with **Not now**. **Download** opens that version's release page on GitHub in
  your browser; nothing is downloaded or installed by the app there (backlog row 180).
- Choose the model set: Engine settings, ONNX Runtime engine, **Model set** offers 2.0.0-onnx.5 (the default, as
  before) or 2.0.0-onnx.4 on Linux and Windows, each marked installed or with its download size. Picking one that isn't
  on the computer downloads it with the setup's own checked, resumable download, next to the one you have; from then on
  the Models folder's **Automatic** runs it (a Models folder chosen by hand goes back to Automatic when you pick a set).
  TensorRT installs into the chosen set's folder: onnx.4 gets its own 2.0.0-onnx.4-trt, and onnx.5 keeps
  2.0.0-onnx.4-trt as in dev.2 and dev.3 (onnx.5's own TensorRT set isn't measured yet). macOS names its one set,
  2.0.0-onnx.5 with its Core ML set (there is no onnx.4 Core ML set) (backlog row 168).
- AMD cards on Linux, **on by default and not yet tested on a real AMD card**: AMD support is new; we're testing it
  ourselves next, and if it doesn't work on your card, please tell us on [GitHub issues](https://github.com/MarcelineVPQ/corridorkey-desktop/issues). The setup and the Engine page
  say so. With no NVIDIA driver loaded (NVIDIA comes first when a PC has both), the setup finds an AMD card ROCm 10.1's MIGraphX
  supports (Radeon RX 7000 and 9000, Radeon AI PRO R9700, Ryzen AI graphics, Instinct MI200/MI300/MI350), says when
  your user needs the `render` and `video` groups, and downloads ONNX Runtime with AMD's ROCm 10.1 and MIGraphX
  libraries (1.02 GB for an RX 7900, each wheel pinned by size and SHA-256) and MIGraphX's two extra model files from
  the published onnx.5 TensorRT release (0.61 GB; the mix parses in MIGraphX at four sizes, checked offline). The GPU
  readout reads the amdgpu driver, a job's first load says it is preparing for the card, and with the AMD runtime installed the engine's
  "no graphics card" message on Linux names AMD too. NVIDIA, Windows, macOS and a Linux PC without an AMD card are
  unchanged; `CK_AMD=0` in the app's environment turns the AMD path off (backlog row 166, docs/AMD.md).
- The Engine page's **Graphics card** is now laid out like NorthXL's GPU card: the card's name in the header, usage and
  memory as bars, then the card's temperature, fan, clock and power. NVIDIA reads them from nvidia-smi, AMD (untested on
  a real card yet) from the amdgpu driver's files; a reading the card doesn't give is left out, never
  shown as 0. As before it is read only while a job runs and the window is shown, and a Mac shows no readout (backlog
  row 171).

## 1.0.0-dev.3

The foundation build: the Mac on par with Linux and Windows, and the checks running on every change.

- **4K on the Mac.** The Core ML model set gains 4096×2160 (padded to 2176×4096), next to 1280×1080 and 1920×1080:
  model set 2.0.0-onnx.5-coreml.1. On the 16 GB M6 Mac mini, 04_5d at 4K keys at 0.38 fps steady (12 frames, window
  4/2), peak 9.8 GB (it fits, tight: 0.8 GB swapped), every pixel of every frame within 1/255 of CUDA's matte (alpha
  MAE 1.32e-5). The Mac setup is 5.74 GB (was 4.76); a Mac with dev.2's set downloads only the 4K files and a new
  coreml.json, never the rest again (backlog rows 60, 174).
- On a Mac the `corridorkey` command line keys without `--device coreml`: `auto`, the default, is Core ML there (the
  app always started it so; backlog row 174).
- The Mac disk image itself is signed and notarized, its ticket stapled: Gatekeeper accepts the downloaded image
  before it is opened (dev.2's image was unsigned, only the app inside it was; backlog row 174).
- Windows: Ctrl+C on `corridorkey run` stops the script at once, cleanly ("cancelled", exit 130). Before, the app
  never read the command line's stop request there, so the script ran on until a second Ctrl+C ended it (backlog
  row 175).
- Releases: every release, development builds too, is a full GitHub release marked Latest (the repository page shows
  the newest build); the update feeds tell Stable from Development by the version, as before (backlog row 173).
- Development: Windows, macOS and Linux CI run on every push to main, each starting the packaged app's
  `corridorkey run` with a time limit (Windows and macOS also the app's first page), so release day finds nothing new
  (backlog row 170).

## 1.0.0-dev.2

The second development build of 1.0: the `corridorkey` command line for render farms and power users, example
submitters for the common farm schedulers, the Console, a command line inside the app, and model set 2.0.0-onnx.5
(a smaller download). Linux and Windows on NVIDIA as dev.1, and the first macOS build: Apple Silicon through Core ML,
1280×1080 and 1920×1080 clips (4K comes later).

**The Electron security fix.** dev.1 runs on Electron 45.0.0-beta.3, whose Node (24.21.0) carries CVE-2026-111497,
fixed in Node 24.22.1 (dev.1's release page says so). This build runs on Electron 45.1.0 (released 2026-10-27, Node
24.22.1, Chromium 156.0.8078.49), the first stable Electron with the fix. The packaged app's Electron fuses are now
set: it ignores `NODE_OPTIONS` and `--inspect`, and loads the app only from its `app.asar` (checked against its
integrity hash on macOS and Windows; not yet run in a Windows or Mac build). Node mode is off: `corridorkey run`
starts the app with its own `--ck-headless` script runner.

**The command line, `corridorkey`** (docs/CLI.md; the wiki's Command line page):

- Keys clips without the app's window, with the app's own engine built in: a whole shot keyed with it is bit for bit
  the app's matte (tested end to end on the CPU against the engine). It ships next to the engine in every package.
  `render`, `verify` (is every frame there and whole; the missing ones as ranges to re-render), `prepare` (checks a
  worker before a farm's tasks; builds TensorRT for a size once) and `info`.
- Frames as Nuke (`-F 1001-1100x2`, lists) and Blender (`-s` / `-e`) give them, numbered as the shot is; outputs to a
  folder or a pattern (`key.####.exr`, `%04d`, `$F4`); `--preroll` / `--tail` warm-up frames for chunks of a shot.
  How many warm-up frames make chunk seams invisible isn't measured yet, so whole shots per task are the advice.
- Output safety: a run writes into a hidden folder of its own and renames the frames into place only at the end,
  all or nothing; each EXR frame is written whole and renamed (the app's jobs too). A killed run never leaves a frame
  at a final name. Frames already there are refused unless `--overwrite` or `--skip-existing`.
- Exit codes that say whether a retry can help, progress lines for OpenJD, Deadline, plain text or JSON, a JSON
  report of the run, a clean stop on SIGTERM / SIGINT (Windows' console close, log-off and shut-down are handled
  too, but not yet run on Windows).
- Without `--models` / `--ort` it uses the app's own installed models and ONNX Runtime, so the Queue's Copy as
  command line runs in a terminal as it is (tested with a fake install; not yet on a graphics card).
- Frame folders are read as the app starts them: scene-linear when the first frame is EXR, display-coded otherwise;
  `--linear` / `--no-linear` choose, and the report says which was used and why. Copy as command and farm export
  write an EXR folder's choice both ways (`--no-linear` when the box is off); the OpenJD templates' scene-linear
  parameter and the Flamenco job type's setting gain a "by the first frame" default.
- `corridorkey __spec --json` describes the whole command line for tools; on Windows it never loads a library from
  the current folder (not yet run on Windows).
- Fixes from the farm review (2026-10-26) before anything shipped: a stepped `-F` keys to the end of its range,
  `-s` / `-e` past the shot are refused like `-F`'s, an absurd preroll is refused instead of overflowing, the final
  renames are all or nothing, a stop during a TensorRT build ends `prepare` cleanly, run folders are unique per
  machine and swept once their run is over, the Deadline plugin quotes Windows paths correctly.

**Render farm submitters** (farm/README.md; the wiki's Render farm page): OpenJD / AWS Deadline Cloud job bundles
(per shot, and chunked), a Deadline 10 plugin, an OpenCue submit script, a Flamenco job type and a shell loop for a
studio without a scheduler. Each keys one whole shot per task by default and checks it with `verify`. None has run on
a real scheduler yet; what was tested, and how, is listed per submitter.

**The Console** (docs/GUIDE.md "Console"; the wiki's Console page), a command line inside the app for power users,
on its own rail icon. Not a system shell: its own commands only, each parsed and checked.

- `render`, `verify`, `prepare` and `info` with the command line's own flags, output and exit codes, plus `help`,
  `apropos`, `cd`, `ls` / `dir`, `history`, `open`, `version` and Tab completion from the command line's own
  definitions.
- Safety: it reads anywhere and writes only into the results and cache folders, the queued clips' folders and folders
  you `allow`; a command that replaces files runs only as `sudo …` after a dialog showing what it replaces, elevated
  for 5 minutes (each elevated command extends it, never past 15), dropped on sleep or quit and meant to drop on a
  screen lock too (on Linux it reads systemd-logind's lock state; not yet tried with a real lock); every elevated command is logged before it runs. The renderer's security policy is
  stricter, and a gate forbids shells and `exec` in the app's code.
- `allow` refuses `/`, a drive's root and the system's folders (also through a link), and warns before allowing the whole home folder.
- On Windows the Console opens a network path (`\\server\…`) only after `allow-server <server>`, until the app quits (Windows sends your sign-in to every server it opens).
- For the pipeline: frame sequences shown and completed as one item (`sh010.####.exr 1001-1100 · missing 1047`);
  every job the queue starts appears as its exact `corridorkey render …` line, and the Queue's **Copy as command**
  copies it, quoted for a terminal; `farm export` writes the queued clips as OpenJD, Deadline 10, OpenCue, Flamenco
  or shell jobs with their settings; `doctor` checks the whole machine with each problem's fix; `-o …_v###/` picks the
  next free version.
- For people who live in a shell: history shortcuts (`!!`, `!$`, `^a^b`, `sudo !!`), readline keys, bookmarks
  (`cd @sh010`), `j` (jump by frecency), `pushd` / `popd`, `${name}` variables (`set -p` keeps one) and lists, a small
  script language (`;`, `&&`, `||`, `for`, `if`, `time`, `run` for `.ckcmd` files; no pipes), and read-only `cat`,
  `head`, `tail`, `wc`, `du`, `tree`.
- Built in phases, each followed by an independent senior review and a command-line / VFX pipeline expert's review;
  every finding they marked must or should was fixed with a test before this build (docs/REVIEW_CONSOLE_*.md), the
  rest are backlog rows.

**Changed**

- **Model set 2.0.0-onnx.5** on Linux and Windows (docs/ONNX_EXPORT.md "onnx.5"; backlog row 165): our own export of
  stage 1 and stage 2, made so AMD's MIGraphX and Apple's Neural Engine can take them. Stage 2's shifted windows are
  one masked attention per Swin block, stage 1's regions are taken by one gather each in the original's frame-major
  token order (no empty tensor at any size), the RMS norms are written in plain operations, and C-RADIO's weights are
  stored in fp16 (ONNX Runtime converted them to fp16 on load before, so the graphics card holds the same weights).
  Corridor's code and weights are unchanged. The models download drops from 3.30 to 2.48 GB (the setup: 4.03 GB on
  Linux, 3.81 GB on Windows, was 4.86 / 4.64). Mattes against onnx.4: all 10 test clips within 0.25-0.50/255 at the
  most, no pixel over 1/255, and no more sizzle. Speed on CUDA (RTX 5080, one run per set): 0.3-3.5 % faster on every
  clip (HD 1280×1080 about 15.5 fps, 4K 0.78 fps), about the size of the run-to-run spread; the same graphics memory
  (one 960×720 clip peaked 0.9 GB lower; README, Speed, "0.0.9-dev"). The setup
  downloads onnx.5 next to an installed onnx.4, whose folder stays as it is.
- macOS moves to onnx.5 too, with its own Core ML set 2.0.0-onnx.5-coreml (1280×1080 and 1920×1080, every node on
  Core ML): the setup is 4.76 GB, was 5.51. Gated on the Mac mini (M6, 16 GB) against CUDA on both sizes: alpha MAE
  2.1-2.5e-5, 0.002 % of pixels over 1/255 at 1280×1080 and none at 1920×1080 (README, Speed, "Apple Silicon (Core ML)").
- TensorRT (Linux, opt-in) keeps dev.1's TensorRT set, 2.0.0-onnx.4-trt (onnx.5's own TensorRT set isn't measured
  yet; choosing the model set comes in dev.4). Its C-RADIO weights (fp32) are no longer in the normal set, so they are
  copied from an installed onnx.4 folder when there is one (5.53 GB in all, as before) and downloaded otherwise
  (7.26 GB).
- **AMD graphics cards, engine only, untested on real hardware:** the engine can run on an AMD card on Linux through
  AMD's MIGraphX provider (`--device migraphx`, ROCm 10.1; docs/AMD.md). It has never run on an AMD card, and the app
  doesn't download an AMD runtime, so the app still needs an NVIDIA card on Linux and Windows. Without AMD's provider
  plugin installed the engine chooses its device exactly as before (NVIDIA, Mac and CPU setups are unchanged). With
  onnx.5, MIGraphX's own parser takes all five networks (their TensorRT-form files) at every size tried (offline
  check, no AMD card).
- An app update now shows itself (it was said only in App settings → Updates): pinned above every page when one is available (Download), downloading, ready (Restart now) or its install failed, and as a dot on App settings whose press opens Updates; Not now hides that step of that version until the next step or a newer one.
- A shipped copy has no developer tools and none of Electron's default reload and close shortcuts (Ctrl+Shift+I, Ctrl+R, F5, Ctrl+W); `npm run dev` keeps them.
- The app runs only its Rust + ONNX Runtime engine: the PyTorch engine is gone from it (the Engine page's
  "Benchmark reference" section, its CorridorKey2.0 folder setting, and the PyTorch-only limits on a clip's codec,
  internal resolution and input precision). A settings file that still names the folder loads as before; the key is
  dropped. Comparisons with Corridor's original stay in the repository's tools (`tools/vs_original.sh`,
  `tools/engine_bench.mjs`), which run it from its own checkout and venv.
- The computer stays awake while the queue or a Console `render` / `prepare` runs, on every system (the display may
  still sleep): a laptop that used to sleep during a long queue now doesn't, until it stops. Measured on a Mac: asleep
  mid-job, a 0.08 s network call took 300 s.
- Security: every message from the app's page to the app is checked to come from that page, and the page is denied
  every permission (camera, microphone, notifications and the rest; it uses none).
- The automatic window on 8 GB cards with a graphics-memory limit (a clip's Memory limit, `--max-vram`, a farm's
  MaxVram): the memory estimate now also holds the peaks measured on an RTX 2070 SUPER 8 GB under a 7.0 / 7.4 GiB
  limit, which ran the same windows in up to 2.7 GiB less than the 16 GB card's table. Measured at a ~7.4 GiB limit:
  1280×1080 clips get 24/12 in low-VRAM mode (was 8/4) and 1920×1080 8/4 in the normal mode (was low-VRAM). Limits
  under 7.0 GiB were not measured: a 5.5 GiB limit (a 6 GB card) now picks 8/4 at 1920×1080 (was 2/1), not yet run on a
  6 GB card. 12 and 16 GB cards keep their windows. Without a limit (the app's Auto) the windows stay dev.1's until
  Auto is measured on an 8 GB card (docs/ENGINE_RUST.md).

- macOS, ready for the first Mac build (this build has none): the app asks the engine for Core ML, and the setup
  downloads the Core ML model set with the models (for 1280×1080 and 1920×1080 clips; 4K has no Core ML set yet,
  backlog row 60; the setup is 4.76 GB in all with onnx.5-coreml, above; into the model set's own folder, checked by SHA-256,
  resumable; a Mac that already has the models gets it the next time the setup runs). An engine
  started on a Mac without Core ML now says so instead of asking for an NVIDIA card.
- Core ML runs on the CPU and GPU by default (`CK_ENGINE_COREML_UNITS`, was all units): with the Neural Engine
  allowed, Core ML compiled stage 2 again on every load (145-188 s) and its first call passed 9.7 GB, more than a 16 GB
  Mac has. On CPU + GPU a 1280×1080 job peaks at 1.8-3.4 GB up to window 8/4, its mattes within 1/255 of CUDA's
  (measured on an M6 Mac mini, 2026-10-27; docs/ENGINE_RUST.md "Core ML on a 16 GB Mac").
- Core ML, measured on the same Mac: Apple's Neural Engine compiler crashes on stage 2 (a stack overflow in its
  attention scheduler), so nothing was cached and every load compiled it again; C-RADIO, MoGe and RVM compile and
  cache, but run 2-8× slower on the Neural Engine than on the GPU, so CPU + GPU stays the default. A low-memory Core ML
  job now loads the next phase's network on its own thread, as on CUDA (its memory is still to be measured), and stage 1's frames are converted to its input type on the input thread. Two measurement switches, off
  by default: `CK_ENGINE_COREML_FAST_PREDICTION`, `CK_ENGINE_COREML_LOW_PRECISION_GPU`.

**Fixed**

- Appearance → Glass showed no glass in installed builds: the security policy blocked its displacement maps.
- The engine said its version was 0.2.0 (in its replies, and so in logs): it now says the app's version.
- The Engine page's list of programs using the graphics card showed other programs' whole command lines (a
  Chromium-based app's arguments and home-folder paths): it now shows the program's name alone.
- A folder of EXR frames started as "display-coded", clipping every value above 1 unless the box was noticed: an EXR
  folder now starts scene-linear (PNG/JPEG frames stay display-coded), the box says which its format gives, and a
  change you make to it is that folder's alone. The `corridorkey` command line now does the same (above).
- The Results stills showed faint green lines in black areas (the still's conversion from the engine's 10-bit video
  rounded near-black to green; the outputs themselves were clean): stills are now converted to RGB first, black stays
  black.
- A low-VRAM job under a graphics-memory budget could run out of memory well inside it (RTX 2070 SUPER at 4 GB:
  1/1 windows the estimate fits failed with the engine at 1.3-1.8 GB): each network's memory left room for all five
  networks, though a low-VRAM phase only shares the card with its own and the next phase's. It now leaves room for
  those; normal mode is unchanged. Measured on an RTX 5080 at 4 GB: HD and 4K low-VRAM 1/1 now run, peaks 1.95 and
  3.19 GiB.

**Docs**

- The wiki's pages live in the repository (`docs/wiki/`) and a gate keeps them current: every command, flag, exit code
  and progress format of the command line, every Console command and the engine's messages must be there, and every
  link must resolve; a release is refused while the published wiki differs. New pages: Command line, Render farm,
  Console. The wiki gate also wants every engine option, every clip setting's on-screen name, every app setting
  and every rail page on the wiki (the App settings, Appearance and the other pages now have sections).
- A command-line gate of its own: every engine job option has a flag or a stated reason, and every option the app
  sends reaches the CLI, Copy as command and farm export, tested by reading the copied lines back (docs/CLI.md
  "Adding an option").

**Already in 1.0.0-dev.1, missing from its notes:** the automatic window's graphics-memory table was re-measured on
the model set it ships (onnx.4) before dev.1; on a 16 GB card the old table picked a 1080p window that runs out of
memory on onnx.4.

## 1.0.0-dev.1

The first development build of 1.0: a free desktop app for CorridorKey 2.0, Corridor Digital's AI green and blue
screen keyer, on its own Rust + ONNX Runtime engine, for Linux and Windows (macOS on Apple Silicon follows).

**Platforms in this build:**

- **Linux and Windows need an NVIDIA graphics card** (RTX 20-series or newer, 8 GB or more). The engine keys only on CUDA: AMD and
  Intel cards aren't supported, and nothing falls back to the CPU. Keying on Windows is untested on a real NVIDIA PC
  (below).
- **No macOS build in this one.** The Mac's Core ML engine can't key yet: setup doesn't install the Core ML models
  (backlog row 59), the Core ML set covers only 1280×1080 clips (row 60), and stage 1 needs more memory under Core ML
  than a 16 GB Mac has at a 4-frame window (measured on an M6 Mac mini, 2026-10-26; shorter windows not yet; row 24). README, "macOS, honestly", lists
  what's left.

**What's in it:**

- First app: clip queue (videos, frame folders, batch folders, companion hints found next to
  clips), per-clip hint/output/memory settings, one engine process for the queue, live progress
  from the engine (stages, frames, measured speed, the memory window used), result stills,
  errors with the engine's output, cancel.
- The CorridorKey engine in Rust on ONNX Runtime (CUDA, fp16), inside the app: 1.5-1.8× faster
  than the PyTorch version on every HD test clip and 2.4-2.7× faster on 4K (RTX 5080; README, Speed),
  using less graphics memory and RAM, with the same mattes (README, Quality); portrait clips
  work (model set `2.0.0-onnx.4`, computed with CorridorKey 2.0's own precision policy). The PyTorch engine stays available as the reference.
- A setup screen on first start: three steps, each ticked when done (download the runtime and
  models, ffmpeg, add your first clip). Engine, Open the setup brings it back.
- Installs itself: the setup downloads the GPU runtime (ONNX Runtime and
  NVIDIA's CUDA / cuDNN libraries, from PyPI) and the CorridorKey models (from this repository's
  releases), a 4.9 GB download once, with progress, stop and resume, every file SHA-256 checked. The whole
  install is less than half the original CorridorKey 2.0 setup (README, Install size).
- The Engine page lists what it finds (Automatic = the newest) with Browse… for anything else, and
  checks ffmpeg: if it's missing, it offers to install it (apt, pacman) or says what to enable.
- Updates: the AppImage updates itself from signed Stable / Development feeds (signature, size
  and SHA-512 checked; installs beside the running copy, the previous version kept; never a
  downgrade except Back to stable). Packaging as `CorridorKey-Desktop-<version>.AppImage`.
- CorridorKey's own icon (corridorkey.com).
- Windows 10/11: an installer (per user, no administrator), the same setup (the Windows runtime
  packages, ffmpeg through winget) and an uninstaller that asks whether to remove the downloaded data.
  Tested in a Windows 11 virtual machine without an NVIDIA card: keying on Windows is untested
  (README, Requirements).
- App settings, Storage: each folder the app keeps, its size, and Remove; the thumbnail cache prunes
  itself (30 days, 500 MB). README, Uninstall lists every folder the app writes.
- Add clips (video files) and Add folder (frame sequences, folders of clips) are two buttons: one
  dialog can't pick both on Windows or Linux.
- The window title says which CorridorKey and which engine: CorridorKey 2.0 — Rust + ONNX.
- TensorRT, optional (Linux): Engine settings, TensorRT, "Use TensorRT (faster on NVIDIA)", off by default. About
  2× the original's speed at HD with the same mattes (README, Speed, 0.0.6-dev); the first job at each resolution
  optimizes for it once (about 4.5 minutes on an RTX 5080, about 5 at 4K; about half that once TensorRT's timing
  cache is warm). 4K (DCI 4K and UHD, up to 2176×4096) runs on TensorRT too, at the 8/4 window on 16 GB cards, about
  25 % faster than CUDA with the same mattes (README, Speed, 0.0.7-dev); open gate and larger stay on CUDA. Switching it on offers its own download (NVIDIA's
  TensorRT libraries from pypi.nvidia.com and the TensorRT models from this repository's releases, 6.9 GB, with
  progress, stop and resume, every file SHA-256 checked); jobs ask for TensorRT only once it is installed, and the
  job's log says what really ran (and which network stayed on CUDA, and why). Its own item in Storage. Windows
  needs its own engine builder (later); macOS has no TensorRT.
- Deep input: 10/12-bit video (ProRes 4444, HEVC/DNxHR 4:4:4…) is decoded to 16-bit RGB and 16-bit PNG is read at
  full depth, so film plates reach the model without rounding to 8 bits. Measured on a 4K plate: the matte is
  identical to keying the same plate as 16-bit frames; the old 8-bit read put one hair-edge pixel in twelve off by
  up to 15/255 (README, Quality). No measurable time cost (within run-to-run spread); 8-bit sources are unchanged.
  Since 2026-10-25 it is an opt-in per clip (Input precision: "Read 10/12-bit plates at 16 bits (differs from
  CorridorKey 2.0)", the engine's `input_bit_depth`); by default every input is read exactly as CorridorKey 2.0
  reads it, byte for byte (tested on 12-bit ProRes 4444, 10-bit ProRes 422 HQ and 16-bit PNG). This also fixed
  the 8-bit read of 10/12-bit 4:2:2 and 4:2:0 video, which differed from OpenCV's by up to 4 levels.
- EXR outputs to the studio convention (Rust engine): frames named `<clip>_<output>.<number>.exr` with the source's
  own frame numbers and padding (a frame folder's `04_5d_00065.exr` gives `04_5d_alpha.00065.exr`; video counts
  from 1001), the alpha EXR's matte in channel `A` (Nuke and OpenImageIO read it as alpha), and the cutout
  premultiplied (RGB × alpha). On purpose this differs from the original CorridorKey's EXR writer
  (`alpha_000000.exr` from 0, the matte as `Y`, a straight cutout); the matte values themselves are unchanged.
- Video outputs for film work (Rust engine): a Codec choice per clip. Lossless H.264 10-bit 4:4:4 (the default; only
  the 10-bit rounding is lost, never more than 0.16/255 on the matte), DNxHR 444 10-bit in a .mov (Linux and Windows;
  within 1.3/255), or H.264 CRF 12 (the original's small files; up to 21/255 on hair edges). Measured against EXR on an
  HD clip and the 4K 04_5d plate (README, Quality, "Video outputs"). The Mac has lossless H.264 for now; Apple's ProRes
  4444 XQ comes with the Mac work. ffmpeg's ProRes encoder is no longer used: the video cutout is premultiplied colour
  with the Alpha output as its alpha (written with it); EXR keeps the premultiplied RGBA cutout. The ffmpeg check asks
  for libx264 with 10-bit (and dnxhd on Linux and Windows) and says plainly when the system's libx264 is 8-bit only.
  New protocol field `video_codec` (docs/ENGINE_PROTOCOL.md); the PyTorch reference engine still writes CRF 12.
- Parity with every option of the original's command line (docs/PARITY.md, each option with its verdict). Internal
  resolution (the original's `--model_scale`), per clip in Queue: Full / ¾ / ½ / ¼; the networks run at the scaled
  size with cv2's Lanczos-4 ported bit for bit and the outputs come back at the clip's size; `_settings.txt` writes
  the real scale and the memory estimate follows it (Rust engine; speed and matte per scale not measured yet). Linear
  exposure (the original's `--linear_brightness` / `--linear_contrast` / `--linear_contrast_pivot`) for video clips,
  Queue → Linear exposure. `start_mode` / `seed` in the engine protocol (NumPy's generator bit for bit). Checked end to
  end on the CPU in float32 against the original's runtime (alpha MAE below 5e-7). New protocol fields `model_scale`,
  `linear_brightness`, `linear_contrast`, `linear_contrast_pivot`, `start_mode`, `seed` (docs/ENGINE_PROTOCOL.md).
- Colour management, engine (Rust engine; the app's menus come next): OpenColorIO 2.5 built into the engine, so a
  clip can be given in its own colour space (ACEScg, ACES2065-1, the camera log spaces of OCIO's ACES studio config,
  or any space of a studio's own config, `$OCIO` honoured). The engine converts it exactly to what the model was
  trained on (linear Rec.709) and writes the EXR outputs back in the clip's space (or another chosen one); the
  alpha is never converted. Bit-identical to PyOpenColorIO on every colour space of the studio config and on a
  studio config with a show LUT, `$SHOT` and a CDL; a plate keyed in ACEScg or ACES2065-1 gives today's matte to
  within 1/256 (README, Quality). Jobs without a colour space run exactly as before (bit-identical). EXR and image
  sequences in this version; colour-managed video input comes next. New protocol fields and a `colorspaces` command
  (docs/ENGINE_PROTOCOL.md).
- Graphics memory → Manual shows the engine's own estimate next to each window and the Low-memory switch, before the
  job ("about X GiB of Y GiB free: fits"), from a new `estimate` engine command (docs/ENGINE_PROTOCOL.md; backlog row 41).
- Graphics memory → Memory limit: Auto or a limit in GiB per clip (the engine's `vram_budget_gb`), with a default for
  new clips in App settings → Graphics memory, shown with the card's size and free memory from the engine's reading;
  the estimate is weighed against it. Auto means the free memory when the job starts, as before (docs/GUIDE.md;
  backlog row 43). A finished job shows the limit it ran with.
- App settings → Storage: the cache folder can move (Change…, Default; move the files, copy-verified before any
  delete, or start fresh, asked), shows its size per clip and per TensorRT range, and every folder has Open
  (docs/GUIDE.md; backlog row 44).
- Cache folder on a drive that isn't connected: the app never makes the chosen location itself (only its own folder
  inside one that is there); Storage says "Drive not available", the cache uses the default folder for now (nothing
  moved or deleted, the choice kept for the next start), with Use the default folder from now on. Start queue is
  disabled with "Moving the cache folder…" while the cache moves.
