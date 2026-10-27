# Building from source

For developers. The app is Electron + React + TypeScript; the keying engine is Rust on ONNX Runtime, in
`engine-rs/`. The app and the engine talk over a small JSON-lines protocol,
[docs/ENGINE_PROTOCOL.md](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/docs/ENGINE_PROTOCOL.md).
The engine itself is described in
[docs/ENGINE_RUST.md](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/docs/ENGINE_RUST.md).

## What you need

- **Node.js 22 or newer** and npm.
- **Rust**, through rustup: the toolchain is pinned in `engine-rs/rust-toolchain.toml` (1.93.0, with clippy and
  rustfmt), so rustup picks the right one by itself inside `engine-rs/`.
- **CMake and a C++ compiler**: the engine builds OpenColorIO from source and links it in (a few minutes the first
  time).
- **ffmpeg** on your PATH, as for the app.
- To key, an NVIDIA graphics card, as for the app.

## Run the app

```
git clone https://github.com/MarcelineVPQ/corridorkey-desktop.git
cd corridorkey-desktop
npm install
npm run dev
```

- `.npmrc` sets `legacy-peer-deps=true`: npm 9 and 10 crash in peer resolution on this dependency set without it.
- If Electron's binary is missing after `npm install`, run `node node_modules/electron/install.js`.

The app run from source uses the same data folder as the installed app, so its setup downloads the GPU runtime and
the models the same way. It looks for the engine program in `engine-rs/target/release/`. Build a GPU engine there
with the features the shipped engine uses:

```
cd engine-rs
cargo build --release --locked -p ck-engine --no-default-features --features ort-dynamic,cuda,tensorrt,ocio
```

The default features (`ort-static`, `ocio`) build a CPU-only engine with a static ONNX Runtime, used by the tests.
Self-update is off in a copy run from source.

## Checks

```
npm run check          # TypeScript types, formatting, the gates (the wiki's too), unit tests, the tools' tests
npm run check:engine   # engine-rs: cargo fmt --check, cargo clippy -D warnings, cargo test
npm run check:targets  # the engine's clippy for Windows and macOS, from Linux
```

`npm run build` builds the app with electron-vite.

## Packages

| Command | Builds |
| --- | --- |
| `npm run dist:linux` | the Linux AppImage: the engine linked for glibc 2.28 (`tools/build_engine.sh`, cargo-zigbuild with Zig), TensorRT's engine builder (`tools/build_trt_builder.sh`), then electron-builder |
| `npm run dist:win` | the Windows installer, cross-built from Linux (`tools/build_engine.sh --windows`, MinGW-w64; the NSIS installer through Wine) |
| `npm run dist:mac` | the macOS disk image (Apple Silicon); the engine is built on a Mac |

Outputs land in `release/`. The build scripts' headers say what each needs (Zig in a Python venv for the glibc 2.28
build, the `x86_64-pc-windows-gnu` Rust target and MinGW for Windows). They run their builds under
`systemd-run --user` with a memory cap, so they expect a Linux desktop with systemd. How releases and the signed
update feeds are made: [docs/RELEASING.md](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/docs/RELEASING.md).

## Comparing with the original

The app runs only its Rust + ONNX Runtime engine; nothing PyTorch ships in it. The original CorridorKey 2.0
(PyTorch) stays the benchmark reference through the repository's tools, which run it from its own CorridorKey2.0
checkout and venv: `tools/vs_original.sh` (the same clips through both: speed and mattes compared) and
`tools/engine_bench.mjs python` (speed), with `tools/matte_compare.py` and `tools/side_by_side.py`. They're described
in the README,
[Test it yourself](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/README.md#test-it-yourself). None of
it is needed to use or build the app.

## The command line

`tools/build_engine.sh` builds the command line, `corridorkey` (crate `ck-cli`), next to the engine, the same way; it
ships beside the engine in every package (from the next development build, 1.0.0-dev.2). Its tests run without a
model set or a graphics card: `cd engine-rs && cargo test -p ck-cli`. How to use it: [Command line](Command-Line).

The wiki itself lives in the repository, in `docs/wiki/`: change a page there, in the same pull request as the change
it describes. `npm run gates` checks it (`tools/check_wiki.mjs`: every command, flag, exit code and progress format of
the command line, every Console command, the engine's messages, and the links).

## Contributing

Please read [CONTRIBUTING.md](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/CONTRIBUTING.md) first:
small, focused pull requests; `npm run check` (and for engine changes `npm run check:engine` and
`npm run check:targets`) must pass; a fix comes with a test that fails without it; anything that changes speed or
mattes comes with numbers.
