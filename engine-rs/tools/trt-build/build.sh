#!/bin/bash
# Build ck-trt-build (the strongly typed TensorRT engine builder corridorkey-engine runs for opt-in TensorRT jobs).
#   build.sh TENSORRT_LIBS_DIR OUT_DIR
# TENSORRT_LIBS_DIR: the folder with libnvinfer.so.10 and libnvonnxparser.so.10 (the tensorrt-cu13-libs wheel's
# tensorrt_libs). Headers: TensorRT 10.16's public headers (Apache-2.0, NVIDIA/TensorRT release/10.16 at
# d0faf303, onnx/onnx-tensorrt release/10.16-GA at 6bde6596), fetched into OUT_DIR/include and checked by sha256.
# The CUDA runtime header is a two-line stand-in (the builder makes no CUDA calls of its own).
set -euo pipefail
LIBS=$1; OUT=$2
INC=$OUT/include; mkdir -p "$INC" "$OUT/lib"
T=https://raw.githubusercontent.com/NVIDIA/TensorRT/d0faf303ba766f20cd9fd8c413a112fc2e5a397b/include
P=https://raw.githubusercontent.com/onnx/onnx-tensorrt/6bde6596eca84abf9afe9b4d21c18c32800fd3ad
# loop: NOT-WORTH — the pinned headers' checksums, once per builder build
while read -r sum name; do
  [ -f "$INC/$name" ] || { if [ "$name" = NvOnnxParser.h ]; then curl -sSf -o "$INC/$name" "$P/$name"; else curl -sSf -o "$INC/$name" "$T/$name"; fi; }
  echo "$sum  $INC/$name" | sha256sum -c --quiet -
done <<'SUMS'
eb1403af5c331ed0df8da8efc1908d36e440479a41631dd89ca7de69ee5c70c0 NvInfer.h
6990df744da602c1e2ed19e9015c6ce9fc85190eeaf67040a3e53ae3fdc743bd NvInferImpl.h
3e10fe5b85545f2e956e6935271badf0b1c72553b698000a61d46d69c5d53030 NvInferLegacyDims.h
774e457b2e80f27502ea1aed8132949f6e0788251b5374948e1bfdc9de9fb0ee NvInferPluginBase.h
c1aeed090422a0f214aa3dc334d3e435f3dd3a6cf14caece9fe9ef4daeeb50ec NvInferPluginUtils.h
0cfa22bcffd500e63effc1fe013307440b84694587916e9ea69cdbb13a8d1cd6 NvInferRuntimeBase.h
9461c9d07403c5dd1f8a6dea17fa5c3fe5cef7c4290c6768370a1d8139d4ac5d NvInferRuntimeCommon.h
fc21f284d8c7b6a092f221048483e9362375cda2a7f8e31577318290c1637f76 NvInferRuntime.h
cee843344163279c6abaa4c4cb83a518e6da5af7d4e2f571861e1a36c6899fba NvInferRuntimePlugin.h
da560c83ecc443b6e195959c2048ce6ba26e85b0347f5f905a63608635f7314e NvInferVersion.h
18735e1b92addcf2a9fd1480721e41d4ba86b39c4e1bb05a3bdde2c8638f6d49 NvOnnxParser.h
SUMS
printf '#pragma once\ntypedef struct CUstream_st* cudaStream_t;\ntypedef struct CUevent_st* cudaEvent_t;\n' > "$INC/cuda_runtime_api.h"
ln -sf "$LIBS/libnvinfer.so.10" "$OUT/lib/libnvinfer.so"
ln -sf "$LIBS/libnvonnxparser.so.10" "$OUT/lib/libnvonnxparser.so"
g++ -O2 -std=c++17 -Wno-deprecated-declarations -I "$INC" "$(dirname "$0")/ck_trt_build.cpp" -L "$OUT/lib" -lnvinfer -lnvonnxparser \
  -Wl,--allow-shlib-undefined -o "$OUT/ck-trt-build"
echo "built $OUT/ck-trt-build"
