#!/bin/bash
# Build the production ONNX set for the Rust + ONNX Runtime engine (CPU only).
#   opset 23, onnx_patches v2 (mask-free Swin), every Attention -> com.microsoft
#   MultiHeadAttention (to_mha.py), fp32 + fp16, then speed_patches.py on stage 1 / stage 2 (exact rewrites,
#   set 2.0.0-onnx.2 on).
#   fp16 (set 2.0.0-onnx.4 on): MoGe, RVM, stage 1, stage 2 follow the original's precision policy
#   (torch.autocast("cuda", bfloat16)): exported under fp16 autocast with CUDA autocast's fp32 list
#   (export.py --amp, autocast_policy.py), then fold_casts.py turns the weight casts into fp16 weights (exact).
#   onnx.3 and before exported them from model.half(): norms, residual streams and resizes ran in fp16.
#   C-RADIO stays as in onnx.3: fp16 autocast with fp32 weights (export.py --autocast16).
# CK_REUSE_FROM=<set folder>: copy the files whose recipe this script didn't change since onnx.3 (every fp32
#   file, C-RADIO fp16) from that set instead of exporting them again; never a hard link.
# Output: $CK_MODELS_DIR (default <scratch>/models-<version>)/ck2-<piece>-<fp32|fp16>.onnx(+.data) + manifest.json
# Never point it at an existing set: build into a new folder.
# Each step runs under a memory cap (run.sh): CK_MEM_<STEP>_<piece> (STEP: EXPORT, FOLD, MHA, SPEED; e.g.
#   CK_MEM_EXPORT_stage1=7G), default 16G. Set them at 1.5x a measured peak. Stops on the first failure.
set -e
S=${CK_ONNX_SCRATCH:-$HOME/.cache/claude-scratch/corridorkey-onnx}
export CK_ONNX_SCRATCH=$S
D=$(dirname "$0"); RUN="$D/run.sh"
VERSION=${CK_ONNX_VERSION:-2.0.0-onnx.4}
OUT=${CK_MODELS_DIR:-$S/models-$VERSION}
mkdir -p "$OUT"
cap() { local v="CK_MEM_$1_$2"; echo "${!v:-16G}"; }
for p in cradio moge rvm stage1 stage2; do
  for prec in fp32 fp16; do
    tag=prod_${prec}
    if [ -n "${CK_REUSE_FROM:-}" ] && { [ $prec = fp32 ] || [ $p = cradio ]; }; then
      echo "=== reuse $p $prec from $CK_REUSE_FROM"
      cp --reflink=auto "$CK_REUSE_FROM/ck2-${p}-${prec}.onnx" "$CK_REUSE_FROM/ck2-${p}-${prec}.onnx.data" "$OUT/"
      continue
    fi
    if [ $prec = fp16 ]; then
      [ $p = cradio ] && flag=--autocast16 || flag=--amp
    else flag=""; fi
    avail=$(free -g | awk '/Mem:/{print $7}')
    [ "$avail" -lt 8 ] && { echo "host available ${avail}G < 8G, stop"; exit 1; }
    echo "=== export $p $prec $(date +%T)"
    "$RUN" $(cap EXPORT $p) export.py $p --opset 23 --patch $flag --tag $tag | grep -E "^EXPORT_RESULT" | cut -c1-200
    grep -q "\"file\": \"$S/onnx/${p}_${tag}.onnx\".*\"ok\": true" <(tail -1 $S/onnx/export_log.jsonl) || { echo "export failed"; exit 1; }
    if [ "$flag" = --amp ]; then
      "$RUN" $(cap FOLD $p) fold_casts.py $S/onnx/${p}_${tag}.onnx $S/onnx/${p}_${tag}_fold.onnx
      tag=${tag}_fold
    fi
    if [ $p = stage1 ] || [ $p = stage2 ]; then
      "$RUN" $(cap MHA $p) to_mha.py $S/onnx/${p}_${tag}.onnx $S/onnx/${p}_${tag}_mha.onnx $p
      "$RUN" $(cap SPEED $p) speed_patches.py $S/onnx/${p}_${tag}_mha.onnx "$OUT/ck2-${p}-${prec}.onnx"
    else
      "$RUN" $(cap MHA $p) to_mha.py $S/onnx/${p}_${tag}.onnx "$OUT/ck2-${p}-${prec}.onnx" $p
    fi
  done
done
"$RUN" 16G make_manifest.py "$VERSION" "$OUT"
