# A Mac for testing (Apple Silicon)

GitHub's macOS runners are virtual Macs without the GPU or the Neural Engine: they prove the build and the app, not
keying. The macOS gate for 1.0 (BACKLOG row 24) needs a real Apple Silicon Mac: Core ML mattes within fp16 rounding
of CUDA on the same clips, and real speed. This is how a Mac on the local network becomes that test machine,
driven over SSH from the Linux PC that builds the releases.

## On the Mac (once, a few minutes)

1. Finish macOS setup and install the updates (System Settings → General → Software Update).
2. **Remote Login:** System Settings → General → Sharing → turn on **Remote Login**. Note the address it shows
   (`ssh <user>@<name>.local`, or the IP from System Settings → Network). "Allow access for": your user only.
3. Keep it awake while it's plugged in: System Settings → Energy → turn on **Prevent automatic sleeping when the
   display is off**. (A test run that sleeps halfway measures nothing.)
4. Command Line Tools (compilers, git): in Terminal, `xcode-select --install`.
5. Homebrew (ffmpeg comes from it, as for users): the one-line installer at https://brew.sh, then
   `brew install ffmpeg node@22 rsync` (rsync: Homebrew's, faster and more compatible than macOS's own).
6. Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` (the repository's
   `engine-rs/rust-toolchain.toml` then installs the pinned version by itself).

## From the Linux PC (once)

```
ssh-copy-id <user>@<mac>.local        # key-based login; the Mac asks for its password this one time
ssh <user>@<mac>.local 'sw_vers; sysctl -n machdep.cpu.brand_string hw.memsize'
```

Then turn off password logins for SSH on the Mac (keys only): in `/etc/ssh/sshd_config.d/` add a file with
`PasswordAuthentication no` and `KbdInteractiveAuthentication no`, and restart Remote Login (off and on).

## The Mac's screen from the Linux PC (optional)

For the times you want to see the Mac's desktop (first app runs, the original's plugins in Resolve or Nuke):

1. On the Mac: System Settings → General → Sharing → turn on **Screen Sharing**. Under its ⓘ, allow your user only,
   and turn on **VNC viewers may control screen with password** (most Linux viewers need it) with a password of its own.
2. On the PC, through the SSH login above, so the screen travels encrypted and the Mac needn't expose port 5900:
   ```
   ssh -N -L 5900:localhost:5900 <user>@<mac>.local
   ```
   then connect **KRDC** (KDE) or **Remmina** to `vnc://localhost:5900`. (Remmina can also use Apple's own login
   instead of the VNC password.)
3. Headless: a Mac mini with no display attached often gives Screen Sharing a low resolution. An HDMI dummy plug
   (a few dollars) makes it behave as if a monitor were connected.

## A test run (the gate, one command on the Linux PC)

```
tools/mac_gate.sh --host <user>@<mac>.local --provider coreml --window 4/2   # THE gate: Core ML, HD, EXR clip first
tools/mac_gate.sh --host <user>@<mac>.local --provider coreml --window 4/2 --coreml-units cpu-gpu   # then: no Neural Engine
tools/mac_gate.sh --host <user>@<mac>.local --provider coreml --window 8/4 --steps 5,6,7            # then: the longer window
tools/mac_gate.sh --host <user>@<mac>.local                     # a CPU rehearsal (not a gate run)
```

Core ML (phase 1, BACKLOG row 24): Core ML compiles for fixed shapes, so the gate runs the **Core ML set** built
offline for the HD size only (1280x1080 clips, padded 1152x1280; stage 1 at 4 or 8 frames per window, C-RADIO /
MoGe at 4 per call in low-memory mode): `engine-rs/export/coreml/build_coreml_models.sh` → `OUT/set` (default
`--coreml-set ~/.cache/claude-scratch/coreml-p1/set`; release assets later, never in git). The gate copies it next to
the model set on the Mac (sha256 checked on both sides) and refuses a window the set wasn't built for. Its default
clips are HD only, decode-stable first: an exact 1280x1080 crop of the 4K half-float EXR plate 04_5d (made here once,
no decoder, no resampling; the row-31 study found 8-bit video decodes differ by CPU SIMD), then the three 12-bit
ProRes HD clips. Window 4/2: stage 1's attention scores at 1152x1280 take ~2 GB fp16 at 4 frames, ~4 GB at 8 (the
Core ML study), so 4/2 is the safe first run in 16 GB of unified memory and 8/4 the second. The first load compiles
each network for Core ML (minutes possible; cached in `~/Library/Caches/corridorkey-desktop/coreml`), so the stall
watchdog is 3600 s for coreml.

From this PC's committed HEAD (it refuses a dirty tree), over SSH, no GitHub: preflight (macOS, chip, memory,
disk, tools; it names what's missing), the code copied to `~/ck-gate/src` and the engine built there, the pinned
macOS ONNX Runtime and the model set copied and checked by sha256, the clips copied (HD: metal_glasses,
locked_backdrop, with_motion_blur; 4K: 04_5d; `--clips` to choose), keying on the Mac (`tools/engine_bench.mjs`,
detached under `caffeinate`: run the same command again to follow it after a dropped connection), the same clips
keyed here with CUDA as the reference (refused while Sonata plays; `--ref DIR` reuses one), and the Mac's outputs
pulled back and compared exactly (EXR float, read by OpenCV). The report folder
(`~/.cache/claude-scratch/mac-gate/<date>-<commit>/report.md`) has the matte table, speed and memory on both
machines, side-by-side images of each clip's worst frame, the Mac's facts, the provider that really ran, and a
verdict against the bar (the fp16-vs-fp32 difference we published, docs/ENGINE_RUST.md). `--dry-run` prints every
step; `--help` lists the options (window, precision, frames, steps).

The app itself (`npx -y npm@10.9.2 ci && npm run check && npm run dist:mac` in a clone on the Mac) is checked
separately; the signed image comes from the macOS workflow. Memory: the Mac's GPU shares its unified memory with
everything else; note the size in every result (16 GB: HD and correctness first, 4K windows measured, not assumed).

## Later, optional

- **A self-hosted GitHub runner** on the Mac, so the macOS workflow runs on real Apple hardware (GitHub →
  Settings → Actions → Runners → New self-hosted runner; macOS ARM64). Only for this private-to-us workflow,
  run on demand.
- **Signing and notarization locally** with Apple's own `codesign` / `notarytool`, so the signing secrets
  could leave GitHub if that's ever preferred.

## After the gate: the plugin parity checklist

With Corridor's own CorridorKey 2.0 plugin installed in DaVinci Resolve on the Mac (Marcy's licence), go through every
control it offers (the alpha hint, marking the subject on one frame, despill, the temporal frames with their memory
readout, the quick single-frame preview, the outputs) and mark each one against CorridorKey Desktop: matched,
different by design, or a gap. Each gap becomes a backlog row (38, 39 and 41 came from the launch video). The list
feeds the scorecard's capability axis (row 36). It's a check of what users will expect, not a copy of Corridor's
paid plugin.

