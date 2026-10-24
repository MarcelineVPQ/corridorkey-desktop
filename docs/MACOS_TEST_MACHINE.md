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

## A test run (the gate, one command on the Linux PC)

```
tools/mac_gate.sh --host <user>@<mac>.local                     # today: the engine on the Mac's CPU
tools/mac_gate.sh --host <user>@<mac>.local --provider coreml   # once the engine has the Core ML provider
```

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
