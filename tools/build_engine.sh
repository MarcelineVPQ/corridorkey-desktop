#!/usr/bin/env bash
# Build the engine that ships inside the AppImage: engine-rs/target/dist/corridorkey-engine.
#
#   tools/build_engine.sh
#
# Linked against glibc 2.28 (the oldest Electron itself supports), so it runs on every Linux the app
# runs on; a plain cargo build links against this desktop's glibc 2.43, newer than Ubuntu 24.04 or
# Debian 12 have. cargo-zigbuild picks the glibc version (`cargo install cargo-zigbuild`; Zig from the
# `ziglang` pip package in ZIG_VENV, a lasting place: python3 -m venv DIR && DIR/bin/pip install ziglang==0.15.2).
# The build stops if the result needs a newer glibc than 2.28. GPU features as the app uses them: ONNX Runtime
# loaded at run time (the in-app install downloads it), CUDA, TensorRT. Memory-capped (its own 12 G scope:
# when release.sh runs it, this cap and release.sh's sit side by side, they don't nest).
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
ENG="$APP/engine-rs"
GLIBC=2.28
ZIG_VENV="${ZIG_VENV:-$HOME/.local/share/corridorkey-release/zig/venv}"
[ -x "$ZIG_VENV/bin/python" ] || { echo "build_engine: no Zig at $ZIG_VENV (see the header)" >&2; exit 1; }
export PATH="$ZIG_VENV/bin:$PATH"
mkdir -p "$ENG/target/dist"
cd "$ENG"
systemd-run --user --scope --quiet --collect -p MemoryMax=12G -p MemorySwapMax=0 -- \
  env PATH="$PATH" cargo zigbuild --release --locked -p ck-engine --no-default-features --features ort-dynamic,cuda,tensorrt \
  --target "x86_64-unknown-linux-gnu.$GLIBC"
# copy beside it, then rename: a running engine keeps its old file ("Text file busy" otherwise)
cp "$ENG/target/x86_64-unknown-linux-gnu/release/corridorkey-engine" "$ENG/target/dist/corridorkey-engine.new"
mv -f "$ENG/target/dist/corridorkey-engine.new" "$ENG/target/dist/corridorkey-engine"
need=$(objdump -T "$ENG/target/dist/corridorkey-engine" | grep -oE "GLIBC_[0-9.]+" | sort -Vu | tail -1)
if [ "$(printf '%s\n' "$need" "GLIBC_$GLIBC" | sort -V | tail -1)" != "GLIBC_$GLIBC" ]; then
  rm -f "$ENG/target/dist/corridorkey-engine"
  echo "build_engine: the engine needs $need, newer than glibc $GLIBC; not shipped" >&2
  exit 1
fi
echo "built $ENG/target/dist/corridorkey-engine (needs $need)"
