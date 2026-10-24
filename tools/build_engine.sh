#!/usr/bin/env bash
# Build the engine that ships inside the AppImage: engine-rs/target/dist/corridorkey-engine.
#
#   tools/build_engine.sh              the Linux engine (engine-rs/target/dist/corridorkey-engine)
#   tools/build_engine.sh --windows    the Windows engine, cross-built here (…/dist/corridorkey-engine.exe; MinGW-w64,
#                                      `rustup target add x86_64-pc-windows-gnu`; it needs only DLLs every Windows has)
#   tools/build_engine.sh --mac        the macOS engine (Apple Silicon), built ON a Mac (GitHub's macOS runner): there
#                                      is no cross-build from Linux without Apple's SDK
#
# Linked against glibc 2.28 (the oldest Electron itself supports), so it runs on every Linux the app
# runs on; a plain cargo build links against this desktop's glibc 2.43, newer than Ubuntu 24.04 or
# Debian 12 have. cargo-zigbuild picks the glibc version (`cargo install cargo-zigbuild`; Zig from the
# `ziglang` pip package in ZIG_VENV, a lasting place: python3 -m venv DIR && DIR/bin/pip install ziglang==0.15.2).
# The build stops if the result needs a newer glibc than 2.28. GPU features as the app uses them: ONNX Runtime
# loaded at run time (the in-app install downloads it), CUDA, TensorRT. Memory-capped (its own 12 G scope:
# when release.sh runs it, this cap and release.sh's sit side by side, they don't nest).
set -euo pipefail
if [ "${1:-}" = --mac ]; then
  # macOS has no systemd-run: the runner's own limits apply
  ENG="$(cd "$(dirname "$0")/.." && pwd)/engine-rs"
  mkdir -p "$ENG/target/dist"
  cd "$ENG"
  cargo build --release --locked -p ck-engine --no-default-features --features ort-dynamic --target aarch64-apple-darwin
  cp "$ENG/target/aarch64-apple-darwin/release/corridorkey-engine" "$ENG/target/dist/corridorkey-engine.new"
  mv -f "$ENG/target/dist/corridorkey-engine.new" "$ENG/target/dist/corridorkey-engine"
  echo "built $ENG/target/dist/corridorkey-engine (macOS arm64)"
  exit 0
fi
if [ "${1:-}" = --windows ]; then
  ENG="$(cd "$(dirname "$0")/.." && pwd)/engine-rs"
  mkdir -p "$ENG/target/dist"
  cd "$ENG"
  systemd-run --user --scope --quiet --collect ${CK_SLICE:+--slice=$CK_SLICE} -p MemoryMax=12G -p MemorySwapMax=0 -- \
    cargo build --release --locked -p ck-engine --no-default-features --features ort-dynamic,cuda,tensorrt --target x86_64-pc-windows-gnu
  cp "$ENG/target/x86_64-pc-windows-gnu/release/corridorkey-engine.exe" "$ENG/target/dist/corridorkey-engine.exe.new"
  mv -f "$ENG/target/dist/corridorkey-engine.exe.new" "$ENG/target/dist/corridorkey-engine.exe"
  # only Windows' own DLLs: a MinGW runtime DLL here would be missing on users' PCs
  extra=$(x86_64-w64-mingw32-objdump -p "$ENG/target/dist/corridorkey-engine.exe" | awk '/DLL Name/ {print tolower($3)}' | grep -vE '^(kernel32|ntdll|msvcrt|bcryptprimitives|advapi32|ws2_32|userenv|api-ms-win-.*)\.dll$' || true)
  [ -z "$extra" ] || { echo "build_engine: the Windows engine needs DLLs Windows doesn't have: $extra" >&2; exit 1; }
  echo "built $ENG/target/dist/corridorkey-engine.exe"
  exit 0
fi
APP="$(cd "$(dirname "$0")/.." && pwd)"
ENG="$APP/engine-rs"
GLIBC=2.28
ZIG_VENV="${ZIG_VENV:-$HOME/.local/share/corridorkey-release/zig/venv}"
[ -x "$ZIG_VENV/bin/python" ] || { echo "build_engine: no Zig at $ZIG_VENV (see the header)" >&2; exit 1; }
export PATH="$ZIG_VENV/bin:$PATH"
mkdir -p "$ENG/target/dist"
cd "$ENG"
systemd-run --user --scope --quiet --collect ${CK_SLICE:+--slice=$CK_SLICE} -p MemoryMax=12G -p MemorySwapMax=0 -- \
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
