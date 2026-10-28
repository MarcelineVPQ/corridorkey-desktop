#!/bin/bash
# Build the TensorRT-ready fp16 set (corridorkey-engine's opt-in TensorRT path) next to a production set.
#   build_trt_models.sh PROD_DIR OUT_DIR      (PROD_DIR: e.g. models-2.0.0-onnx.2; OUT_DIR: a NEW folder)
# Per network: plain attention instead of com.microsoft::MultiHeadAttention, MoGe's antialiased resize as
# weight matrices (to_trt.py), FP32 islands for weight GEMMs / convs (all MatMuls for MoGe), and an EPContext
# stub (trt_ctx.py) that points at <piece>.engine (ck-trt-build makes the engine on the user's card).
# Stage 1 / 2 are re-exported (onnx_patches: Swin regions in 7 dims, TensorRT allows 8) exactly as build_models.sh
# does for the set (2.0.0-onnx.4 on: export.py --amp, the original's precision policy, then fold_casts.py), then
# to_mha.py and speed_patches.py (the 2.0.0-onnx.2 rewrites). to_trt.py keeps fp32 ops fp32 in these mixed files
# (islands only move fp16 ops). CPU only; every step under run.sh: CK_MEM_<STEP>_<piece> (STEP: TRT, EXPORT, FOLD,
# MHA, SPEED, CTX; e.g. CK_MEM_EXPORT_stage1=7G), default 16G (CTX 4G); set them at 1.5x a measured peak.
# 2.0.0-onnx.5: CK_PATCH=--onnx5 (stage 1 / 2 as in build_models.sh) and CK_TRT_CRADIO_FROM=<the onnx.4 set>: onnx.5's
# C-RADIO fp16 file stores fp16 weights, and the fp32 islands here must start from the fp32 weights of onnx.4's file.
set -e
PROD=$1; OUT=$2
S=${CK_ONNX_SCRATCH:-$HOME/.cache/claude-scratch/corridorkey-onnx}
export CK_ONNX_SCRATCH=$S
D=$(dirname "$0"); RUN="$D/run.sh"
cap() { local v="CK_MEM_$1_$2"; echo "${!v:-${3:-16G}}"; }
[ -e "$OUT" ] && { echo "$OUT exists: build into a new folder"; exit 1; }
mkdir -p "$OUT"
# loop: SERIAL-REQUIRED — three networks, one memory-capped to_trt.py at a time
for p in cradio moge rvm; do
  ops="--fp32-ops=Conv,ConvTranspose,MatMul"; [ $p = moge ] || ops="$ops --weights-only"
  src=$PROD; [ $p = cradio ] && src=${CK_TRT_CRADIO_FROM:-$PROD}
  "$RUN" $(cap TRT $p) to_trt.py "$src/ck2-$p-fp16.onnx" "$OUT/ck2-$p-trt-fp16.onnx" $ops
done
# loop: SERIAL-REQUIRED — stage 1 then stage 2, one memory-capped step at a time
for p in stage1 stage2; do
  "$RUN" $(cap EXPORT $p) export.py $p --opset 23 ${CK_PATCH:---patch} --amp --tag trt_fp16 | grep -E "^EXPORT_RESULT" | cut -c1-200
  grep -q "\"file\": \"$S/onnx/${p}_trt_fp16.onnx\".*\"ok\": true" <(tail -1 $S/onnx/export_log.jsonl) || { echo "export failed"; exit 1; }
  "$RUN" $(cap FOLD $p) fold_casts.py $S/onnx/${p}_trt_fp16.onnx $S/onnx/${p}_trt_fp16_fold.onnx
  "$RUN" $(cap MHA $p) to_mha.py $S/onnx/${p}_trt_fp16_fold.onnx $S/onnx/${p}_trt_fp16_mha.onnx $p
  "$RUN" $(cap SPEED $p) speed_patches.py $S/onnx/${p}_trt_fp16_mha.onnx $S/onnx/${p}_trt_fp16_sp.onnx
  "$RUN" $(cap TRT $p) to_trt.py $S/onnx/${p}_trt_fp16_sp.onnx "$OUT/ck2-$p-trt-fp16.onnx" --fp32-ops=Conv,ConvTranspose,MatMul --weights-only
done
# loop: NOT-WORTH — five small stubs, one capped step each
for p in cradio moge rvm stage1 stage2; do
  "$RUN" $(cap CTX $p 4G) trt_ctx.py "$OUT/ck2-$p-trt-fp16.onnx" "$OUT/ck2-$p-trt-fp16-ctx.onnx" $p.engine
done
python3 - "$OUT" <<'PY'
import json, sys
P = ["cradio", "moge", "rvm", "stage1", "stage2"]
json.dump({"tensorrt-fp16": {p: f"ck2-{p}-trt-fp16.onnx" for p in P},
           "tensorrt-fp16-ctx": {p: f"ck2-{p}-trt-fp16-ctx.onnx" for p in P}}, open(f"{sys.argv[1]}/models.json", "w"), indent=2)
PY
echo "TensorRT set in $OUT; merge its models.json keys into the production set's models.json (or copy both sets into one folder)"
