#!/bin/bash
# Build the production ONNX set for the Rust + ONNX Runtime engine (CPU only).
#   opset 23, onnx_patches v2 (mask-free Swin), every Attention -> com.microsoft
#   MultiHeadAttention (to_mha.py), fp32 + fp16 (fp16 exported from model.half();
#   C-RADIO under fp16 autocast = mixed precision with fp32 weights),
#   then speed_patches.py on stage 1 / stage 2 (exact rewrites, set 2.0.0-onnx.2 on).
# Output: $CK_MODELS_DIR (default <scratch>/models-<version>)/ck2-<piece>-<fp32|fp16>.onnx(+.data) + manifest.json
# Never point it at an existing set: build into a new folder.
# Each step runs under a 16G memory cap (run.sh). Stops on the first failure.
set -e
S=$HOME/.cache/claude-scratch/corridorkey-onnx
D=$(dirname "$0"); RUN="$D/run.sh"
VERSION=${CK_ONNX_VERSION:-2.0.0-onnx.3}
OUT=${CK_MODELS_DIR:-$S/models-$VERSION}
mkdir -p "$OUT"
for p in cradio moge rvm stage1 stage2; do
  for prec in fp32 fp16; do
    tag=prod_${prec}
    if [ $prec = fp16 ]; then
      [ $p = cradio ] && flag=--autocast16 || flag=--half
    else flag=""; fi
    avail=$(free -g | awk '/Mem:/{print $7}')
    [ "$avail" -lt 8 ] && { echo "host available ${avail}G < 8G, stop"; exit 1; }
    echo "=== export $p $prec $(date +%T)"
    "$RUN" 16G export.py $p --opset 23 --patch $flag --tag $tag | grep -E "^EXPORT_RESULT" | cut -c1-200
    grep -q "\"file\": \"$S/onnx/${p}_${tag}.onnx\".*\"ok\": true" <(tail -1 $S/onnx/export_log.jsonl) || { echo "export failed"; exit 1; }
    if [ $p = stage1 ] || [ $p = stage2 ]; then
      "$RUN" 16G to_mha.py $S/onnx/${p}_${tag}.onnx $S/onnx/${p}_${tag}_mha.onnx $p
      "$RUN" 16G speed_patches.py $S/onnx/${p}_${tag}_mha.onnx "$OUT/ck2-${p}-${prec}.onnx"
    else
      "$RUN" 16G to_mha.py $S/onnx/${p}_${tag}.onnx "$OUT/ck2-${p}-${prec}.onnx" $p
    fi
  done
done
"$RUN" 16G make_manifest.py "$VERSION" "$OUT"
