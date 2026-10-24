#!/usr/bin/env bash
# Build ck-trt-build, TensorRT's engine builder, for the Linux AppImage: engine-rs/target/dist/ck-trt-build, shipped
# next to the engine in resources/engine (electron-builder.yml), where the engine finds it (engine-rs tensorrt.rs
# builder_path; the app also passes CK_ENGINE_TRT_BUILD, engineFind.ts findTrtBuilder).
#
# It links libnvinfer and libnvonnxparser at run time from the user's TensorRT download (<runtime>/tensorrt_libs,
# install.ts), so the build needs those two libraries to link against: they come from the same pinned
# tensorrt-cu13-libs wheel the app downloads (install.ts TENSORRT.libs; a unit test keeps the two pins equal),
# cached in ~/.local/share/corridorkey-release/tensorrt (a lasting place, like Zig) and checked by SHA-256.
# Compiled with Zig's C++ for glibc 2.28, as the engine (tools/build_engine.sh): Zig links its C++ library in
# statically and exports none of it, so the builder needs only libc and the two TensorRT libraries. The build
# stops if the result needs a newer glibc than 2.28. Memory-capped (its own 4 G scope; CK_SLICE joins a shared
# budget, as tools/build_engine.sh).
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
GLIBC=2.28
ZIG_VENV="${ZIG_VENV:-$HOME/.local/share/corridorkey-release/zig/venv}"
CACHE="${TRT_WHEEL_CACHE:-$HOME/.local/share/corridorkey-release/tensorrt}"
WHEEL=tensorrt_cu13_libs-10.16.1.11-py3-none-manylinux_2_28_x86_64.whl
URL="https://pypi.nvidia.com/tensorrt-cu13-libs/$WHEEL"
SHA256=91142c8ab3c58bed213cf1a563a6eb4e4f0ac529d05b5f909073acece0e3b712
[ -x "$ZIG_VENV/bin/python" ] || { echo "build_trt_builder: no Zig at $ZIG_VENV (see tools/build_engine.sh)" >&2; exit 1; }
mkdir -p "$CACHE" "$APP/engine-rs/target/dist"
if ! echo "$SHA256  $CACHE/$WHEEL" | sha256sum -c --quiet - 2>/dev/null; then
  echo "build_trt_builder: downloading $WHEEL (3.7 GB, once)"
  curl -fL --retry 3 -C - -o "$CACHE/$WHEEL.part" "$URL"
  echo "$SHA256  $CACHE/$WHEEL.part" | sha256sum -c --quiet -
  mv -f "$CACHE/$WHEEL.part" "$CACHE/$WHEEL"
fi
LIBS="$CACHE/libs-10.16.1.11"
if [ ! -f "$LIBS/libnvinfer.so.10" ] || [ ! -f "$LIBS/libnvonnxparser.so.10" ]; then
  mkdir -p "$LIBS"
  # only the two libraries the builder links against (700 MB of the wheel's 4.4 GB)
  systemd-run --user --scope --quiet --collect ${CK_SLICE:+--slice=$CK_SLICE} -p MemoryMax=2G -p MemorySwapMax=0 -- python3 -I -c '
import sys, zipfile, shutil, os
z = zipfile.ZipFile(sys.argv[1])
for n in ("libnvinfer.so.10", "libnvonnxparser.so.10"):  # loop: NOT-WORTH — two libraries, once per cache
    with z.open("tensorrt_libs/" + n) as src, open(os.path.join(sys.argv[2], n + ".part"), "wb") as dst:
        shutil.copyfileobj(src, dst)
    os.replace(os.path.join(sys.argv[2], n + ".part"), os.path.join(sys.argv[2], n))
' "$CACHE/$WHEEL" "$LIBS"
fi
OUT="$APP/engine-rs/target/trt-build"
systemd-run --user --scope --quiet --collect ${CK_SLICE:+--slice=$CK_SLICE} -p MemoryMax=4G -p MemorySwapMax=0 -- \
  env CXX="$ZIG_VENV/bin/python -m ziglang c++ -target x86_64-linux-gnu.$GLIBC" "$APP/engine-rs/tools/trt-build/build.sh" "$LIBS" "$OUT"
BIN="$APP/engine-rs/target/dist/ck-trt-build"
# copy beside it, then rename: a running build keeps its old file
cp "$OUT/ck-trt-build" "$BIN.new"
mv -f "$BIN.new" "$BIN"
need=$(objdump -T "$BIN" | grep -oE "GLIBC_[0-9.]+" | sort -Vu | tail -1)
if [ "$(printf '%s\n' "$need" "GLIBC_$GLIBC" | sort -V | tail -1)" != "GLIBC_$GLIBC" ]; then
  rm -f "$BIN"
  echo "build_trt_builder: ck-trt-build needs $need, newer than glibc $GLIBC; not shipped" >&2
  exit 1
fi
# no C++ library of its own exported: TensorRT's libraries keep using the system's libstdc++
if nm -D --defined-only "$BIN" | grep -qE ' (T|W|V) (_Zn|_Zd|__cxa_)'; then
  rm -f "$BIN"
  echo "build_trt_builder: ck-trt-build exports C++ runtime symbols; not shipped" >&2
  exit 1
fi
echo "built $BIN (needs $need)"
