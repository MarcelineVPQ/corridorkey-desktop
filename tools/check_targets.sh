#!/usr/bin/env bash
# Lint the engine with -D warnings for each system it ships to, with the features tools/build_engine.sh ships there
# (tools/check_features.mjs checks the `lint` lines below against it), from this Linux PC, before a push (clippy
# checks without linking, so no Apple or Windows SDK is needed): a macOS- or Windows-only compile or lint error is
# caught here instead of on GitHub's runner (2026-10-24: two macOS runs failed on errors only that target shows), and
# the Linux release set (cuda, tensorrt), which `npm run check:engine`'s default features don't build, is linted too.
# The targets come with the pinned toolchain (engine-rs/rust-toolchain.toml). Memory-capped like tools/build_engine.sh.
#
# OpenColorIO (backlog row 29): Linux and Windows are linted with the real library (`ocio`: OCIO's CMake build, with
# MinGW for Windows, a few minutes the first time, then cached), so the MinGW build is checked too. macOS can't build
# OCIO here (no Apple SDK): it is linted without `ocio` (ocio-rs's stub, the same Rust API), whose small C++ bridge Zig
# compiles for macOS (ZIG_VENV, as tools/build_engine.sh; CRATE_CC_NO_DEFAULTS keeps the cc crate from asking for
# Xcode's SDK).
set -euo pipefail
cd "$(dirname "$0")/../engine-rs"
ZIG_VENV="${ZIG_VENV:-$HOME/.local/share/corridorkey-release/zig/venv}"
[ -x "$ZIG_VENV/bin/python" ] || { echo "check_targets: no Zig at $ZIG_VENV (see tools/build_engine.sh)" >&2; exit 1; }
lint() {
  local t=$1 features=$2
  shift 2
  echo "check_targets: $t ($features)"
  systemd-run --user --scope --quiet --collect ${CK_SLICE:+--slice=$CK_SLICE} -p MemoryMax=12G -p MemorySwapMax=0 -- \
    env "$@" cargo clippy -q --all-targets -p ck-core -p ck-engine -p ck-cli --no-default-features --features "$features" --target "$t" -- -D warnings
}
lint x86_64-unknown-linux-gnu ort-dynamic,cuda,tensorrt,ocio
lint x86_64-pc-windows-gnu ort-dynamic,cuda,tensorrt,ocio
lint aarch64-apple-darwin ort-dynamic CXX_aarch64_apple_darwin="$ZIG_VENV/bin/python -m ziglang c++ -target aarch64-macos" CRATE_CC_NO_DEFAULTS=1
echo "check_targets: Linux, Windows and macOS lint clean"
