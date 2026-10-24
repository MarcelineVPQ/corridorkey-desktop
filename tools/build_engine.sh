#!/usr/bin/env bash
# Build the engine that ships inside the AppImage: engine-rs/target/dist/corridorkey-engine.
#
#   tools/build_engine.sh
#
# Linked against glibc 2.28 (the oldest Electron itself supports), so it runs on every Linux the app
# runs on; a plain cargo build links against this desktop's glibc 2.43, newer than Ubuntu 24.04 or
# Debian 12 have. cargo-zigbuild picks the glibc version (`cargo install cargo-zigbuild`; Zig from the
# `ziglang` pip package, ZIG_VENV below). GPU features as the app uses them: ONNX Runtime loaded at run
# time (the in-app install downloads it), CUDA, TensorRT. Memory-capped like every build here.
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
ENG="$APP/engine-rs"
GLIBC=2.28
ZIG_VENV="${ZIG_VENV:-$HOME/.cache/claude-scratch/zig/venv}"
export PATH="$ZIG_VENV/bin:$PATH"
mkdir -p "$ENG/target/dist"
cd "$ENG"
systemd-run --user --scope --quiet --collect -p MemoryMax=12G -p MemorySwapMax=0 -- \
  env PATH="$PATH" cargo zigbuild --release --locked -p ck-engine --no-default-features --features ort-dynamic,cuda,tensorrt \
  --target "x86_64-unknown-linux-gnu.$GLIBC"
cp "$ENG/target/x86_64-unknown-linux-gnu/release/corridorkey-engine" "$ENG/target/dist/corridorkey-engine"
need=$(objdump -T "$ENG/target/dist/corridorkey-engine" | grep -oE "GLIBC_[0-9.]+" | sort -Vu | tail -1)
echo "built $ENG/target/dist/corridorkey-engine (needs $need)"
