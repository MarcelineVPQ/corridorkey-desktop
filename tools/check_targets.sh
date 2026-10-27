#!/usr/bin/env bash
# Lint the engine for the other systems from this Linux PC, before a push (clippy checks without linking, so no
# Apple or Windows SDK is needed): a macOS- or Windows-only compile or lint error is caught here instead of on
# GitHub's runner (2026-10-24: two macOS runs failed on errors only that target shows). The targets come with the
# pinned toolchain (engine-rs/rust-toolchain.toml). Memory-capped like tools/build_engine.sh.
#
# OpenColorIO (backlog row 29): Windows is linted with the real library (`ocio`: OCIO's CMake build with MinGW, a few
# minutes the first time, then cached), so the MinGW build is checked too. macOS can't build OCIO here (no Apple
# SDK): it is linted without `ocio` (ocio-rs's stub, the same Rust API), whose small C++ bridge Zig compiles for macOS
# (ZIG_VENV, as tools/build_engine.sh; CRATE_CC_NO_DEFAULTS keeps the cc crate from asking for Xcode's SDK).
set -euo pipefail
cd "$(dirname "$0")/../engine-rs"
ZIG_VENV="${ZIG_VENV:-$HOME/.local/share/corridorkey-release/zig/venv}"
[ -x "$ZIG_VENV/bin/python" ] || { echo "check_targets: no Zig at $ZIG_VENV (see tools/build_engine.sh)" >&2; exit 1; }
# loop: NOT-WORTH — two targets, once per check
for t in aarch64-apple-darwin x86_64-pc-windows-gnu; do
  features="ort-dynamic,cuda,tensorrt,ocio"
  extra=()
  if [ "$t" = aarch64-apple-darwin ]; then
    features="ort-dynamic"
    extra=(CXX_aarch64_apple_darwin="$ZIG_VENV/bin/python -m ziglang c++ -target aarch64-macos" CRATE_CC_NO_DEFAULTS=1)
  fi
  echo "check_targets: $t ($features)"
  systemd-run --user --scope --quiet --collect ${CK_SLICE:+--slice=$CK_SLICE} -p MemoryMax=12G -p MemorySwapMax=0 -- \
    env "${extra[@]}" cargo clippy -q --all-targets -p ck-core -p ck-engine -p ck-cli --no-default-features --features "$features" --target "$t" -- -D warnings
done
echo "check_targets: macOS and Windows lint clean"
