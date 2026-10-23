#!/bin/bash
# Build the TensorRT-ready fp16 set (corridorkey-engine's opt-in TensorRT path) next to a production set.
#   build_trt_models.sh PROD_DIR OUT_DIR      (PROD_DIR: e.g. models-2.0.0-onnx.2; OUT_DIR: a NEW folder)
# Per network: plain attention instead of com.microsoft::MultiHeadAttention, MoGe's antialiased resize as
# weight matrices (to_trt.py), FP32 islands for weight GEMMs / convs (all MatMuls for MoGe), and an EPContext
# stub (trt_ctx.py) that points at <piece>.engine (ck-trt-build makes the engine on the user's card).
# Stage 1 / 2 are re-exported (onnx_patches: Swin regions in 7 dims, TensorRT allows 8), then to_mha.py and
# speed_patches.py (the 2.0.0-onnx.2 rewrites) as in build_models.sh. CPU only; every step under run.sh (16G).
set -e
PROD=$1; OUT=$2
S=$HOME/.cache/claude-scratch/corridorkey-onnx
D=$(dirname "$0"); RUN="$D/run.sh"
[ -e "$OUT" ] && { echo "$OUT exists: build into a new folder"; exit 1; }
mkdir -p "$OUT"
for p in cradio moge rvm; do
  ops="--fp32-ops=Conv,ConvTranspose,MatMul"; [ $p = moge ] || ops="$ops --weights-only"
  "$RUN" 16G to_trt.py "$PROD/ck2-$p-fp16.onnx" "$OUT/ck2-$p-trt-fp16.onnx" $ops
done
for p in stage1 stage2; do
  "$RUN" 16G export.py $p --opset 23 --patch --half --tag trt_fp16 | grep -E "^EXPORT_RESULT" | cut -c1-200
  "$RUN" 16G to_mha.py $S/onnx/${p}_trt_fp16.onnx $S/onnx/${p}_trt_fp16_mha.onnx $p
  "$RUN" 16G speed_patches.py $S/onnx/${p}_trt_fp16_mha.onnx $S/onnx/${p}_trt_fp16_sp.onnx
  "$RUN" 16G to_trt.py $S/onnx/${p}_trt_fp16_sp.onnx "$OUT/ck2-$p-trt-fp16.onnx" --fp32-ops=Conv,ConvTranspose,MatMul --weights-only
done
for p in cradio moge rvm stage1 stage2; do
  "$RUN" 4G trt_ctx.py "$OUT/ck2-$p-trt-fp16.onnx" "$OUT/ck2-$p-trt-fp16-ctx.onnx" $p.engine
done
python3 - "$OUT" <<'PY'
import json, sys
P = ["cradio", "moge", "rvm", "stage1", "stage2"]
json.dump({"tensorrt-fp16": {p: f"ck2-{p}-trt-fp16.onnx" for p in P},
           "tensorrt-fp16-ctx": {p: f"ck2-{p}-trt-fp16-ctx.onnx" for p in P}}, open(f"{sys.argv[1]}/models.json", "w"), indent=2)
PY
echo "TensorRT set in $OUT; merge its models.json keys into the production set's models.json (or copy both sets into one folder)"
