#!/bin/bash
# Re-run only the to_mha step + manifest on the existing exports (no re-export).
set -e
S=${CK_ONNX_SCRATCH:-$HOME/.cache/claude-scratch/corridorkey-onnx}
export CK_ONNX_SCRATCH=$S
D=$(dirname "$0"); RUN="$D/run.sh"
# loop: SERIAL-REQUIRED — 5 networks x 2 precisions, one memory-capped to_mha.py at a time
for p in cradio moge rvm stage1 stage2; do for prec in fp32 fp16; do
  "$RUN" 16G to_mha.py $S/onnx/${p}_prod_${prec}.onnx $S/models/ck2-${p}-${prec}.onnx $p | grep -E "^TO_MHA (dropped|${p})"
done; done
"$RUN" 8G make_manifest.py "${CK_ONNX_VERSION:-2.0.0-onnx.1}" | grep written
