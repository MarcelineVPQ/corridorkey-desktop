# Changelog

## 1.0.0-dev.2 (draft, unreleased)

The second development build of 1.0: the `corridorkey` command line for render farms and power users, example
submitters for the common farm schedulers, and the Console, a command line inside the app. Linux and Windows, as
dev.1; still no macOS build.

**It ships only on a patched Electron.** dev.1 runs on Electron 45.0.0-beta.3, whose Node (24.21.0) carries
CVE-2026-111497, fixed in Node 24.22.1 (dev.1's release page says so). This build waits for a stable Electron with
Node 24.22.1 or newer: on 2026-10-27 there is none (45.0.0 has Node 24.22.0; only 46.0.0-alpha.2 has 24.22.1), and
the app still pins 45.0.0-beta.3. The pin moves before this build is made.

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
  report of the run, a clean stop on SIGTERM / SIGINT (also on Windows' console close, log-off and shut-down).
- Without `--models` / `--ort` it uses the app's own installed models and ONNX Runtime, so the Queue's Copy as
  command line runs in a terminal as it is (tested with a fake install; not yet on a graphics card).
- `corridorkey __spec --json` describes the whole command line for tools; on Windows it never loads a library from
  the current folder.
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
  for 5 minutes (each elevated command extends it, never past 15), dropped on a screen lock or sleep (on Linux
  through systemd-logind); every elevated command is logged before it runs. The renderer's security policy is
  stricter, and a gate forbids shells and `exec` in the app's code.
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

- The app runs only its Rust + ONNX Runtime engine: the PyTorch engine is gone from it (the Engine page's
  "Benchmark reference" section, its CorridorKey2.0 folder setting, and the PyTorch-only limits on a clip's codec,
  internal resolution and input precision). A settings file that still names the folder loads as before; the key is
  dropped. Comparisons with Corridor's original stay in the repository's tools (`tools/vs_original.sh`,
  `tools/engine_bench.mjs`), which run it from its own checkout and venv.

**Fixed**

- Appearance → Glass showed no glass in installed builds: the security policy blocked its displacement maps.
- The engine said its version was 0.2.0 (in its replies, and so in logs): it now says the app's version.

**Docs**

- The wiki's pages live in the repository (`docs/wiki/`) and a gate keeps them current: every command, flag, exit code
  and progress format of the command line, every Console command and the engine's messages must be there, and every
  link must resolve; a release is refused while the published wiki differs. New pages: Command line, Render farm,
  Console.

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
  (backlog row 59), the Core ML set is HD only (row 60), and stage 1 needs more memory under Core ML than a 16 GB Mac
  has at a 4-frame window (measured on an M6 Mac mini, 2026-10-26; shorter windows not yet; row 24). README, "macOS, honestly", lists
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
