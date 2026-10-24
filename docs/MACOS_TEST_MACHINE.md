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
   `brew install ffmpeg node@22`.
6. Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` (the repository's
   `engine-rs/rust-toolchain.toml` then installs the pinned version by itself).

## From the Linux PC (once)

```
ssh-copy-id <user>@<mac>.local        # key-based login; the Mac asks for its password this one time
ssh <user>@<mac>.local 'sw_vers; sysctl -n machdep.cpu.brand_string hw.memsize'
```

Then turn off password logins for SSH on the Mac (keys only): in `/etc/ssh/sshd_config.d/` add a file with
`PasswordAuthentication no` and `KbdInteractiveAuthentication no`, and restart Remote Login (off and on).

## A test run

```
ssh <user>@<mac>.local
git clone https://github.com/MarcelineVPQ/corridorkey-desktop && cd corridorkey-desktop
npx -y npm@10.9.2 ci && npm run check && npm run check:engine
npm run dist:mac                      # unsigned locally; the signed image comes from the macOS workflow
```

Keying tests copy the clips over (`rsync` from the PC), run `tools/engine_bench.mjs` with the Core ML engine,
and compare against the PC's CUDA outputs with `tools/matte_compare.py` and `tools/side_by_side.py`. Memory: the
Mac's GPU shares its unified memory with everything else; note the size in every result (16 GB: HD and
correctness first, 4K windows measured, not assumed).

## Later, optional

- **A self-hosted GitHub runner** on the Mac, so the macOS workflow runs on real Apple hardware (GitHub →
  Settings → Actions → Runners → New self-hosted runner; macOS ARM64). Only for this private-to-us workflow,
  run on demand.
- **Signing and notarization locally** with Apple's own `codesign` / `notarytool`, so the signing secrets
  could leave GitHub if that's ever preferred.
