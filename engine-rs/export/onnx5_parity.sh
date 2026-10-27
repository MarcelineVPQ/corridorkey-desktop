#!/bin/bash
# The parity and speed plan for set 2.0.0-onnx.5 against 2.0.0-onnx.4 (docs/ONNX_EXPORT.md "onnx.5: one masked
# attention"). Nothing here has run: each step is a TEST REQUEST and runs only on Marcy's OK.
#   onnx5_parity.sh STEP OLD_SET NEW_SET OUT
# STEP:
#   torch   PyTorch fp32, CPU: onnx5_patches vs Corridor's unpatched code (parity_patch.py --onnx5), sizes covering
#           1, 2 and 3+ windows per axis, with and without the 8-token padding. ~15 min, ≤ 12 GB.
#   net     ONNX Runtime CPU: C-RADIO (fp16: its weights are now stored in fp16, BACKLOG row 152), stage 1 and
#           stage 2, onnx.4 vs onnx.5, fp32 and fp16 (net_parity.py), small sizes. ~25 min, ≤ 14 GB.
#   cuda    ONNX Runtime CUDA: the same in fp16 at HD (1152x1920, T=8) and 4K (2176x3840, T=4). GPU: only when
#           Sonata isn't playing (checked first). ~10 min.
#   engine  The Rust engine on CUDA, onnx.4 vs onnx.5, the benchmark set (HD clips + the four 4K plates), float EXR
#           outputs (tools/engine_bench.mjs, automatic window), then tools/matte_compare.py --roots (alpha max /
#           mean, % > 1/255: the bar is max ≤ 1/255 against onnx.4) and tools/temporal_stability.py on both (row 53:
#           no more sizzle than onnx.4). bench.json of both runs gives the HD / 4K speed and memory table. ~2-3 h GPU.
#           Per clip, onnx.4 then onnx.5; before each run it waits while Sonata, a game or another GPU job runs.
#   cpu     The same engine A/B on the processor (--device cpu) on the tiny clip. ~30 min.
# Memory: each step under run.sh / memrun (CK_SLICE=claude-work.slice) and heavy.lock.
set -euo pipefail
STEP=$1 OLD=$2 NEW=$3 OUT=$4
D=$(cd "$(dirname "$0")" && pwd) REPO=$(cd "$D/../.." && pwd)
S=$HOME/.cache/claude-scratch
LOCK="flock $S/heavy.lock"
T="$HOME/Videos/corridorkey-tests"
ENGINE=${CK_ENGINE:-$REPO/engine-rs/target/dist/corridorkey-engine}
RT=${CK_RUNTIME:-$HOME/.local/share/corridorkey-desktop/runtime/ort-1.31.0-cuda13}
ORT=$(ls "$RT"/onnxruntime/capi/libonnxruntime.so.* 2>/dev/null | head -1 || true)
LD="$RT/onnxruntime/capi:$RT/nvidia/cu13/lib:$RT/nvidia/cudnn/lib"
PY=$S/corridorkey-onnx/venv/bin/python
mkdir -p "$OUT"
# GPU courtesy: wait (never give up) while Marcy's Sonata plays, a game runs, or another process holds > 1 GiB
wait_gpu() {
  # loop: SERIAL-REQUIRED — poll until the GPU is free [bounded: Sonata / the game closing; Marcy can stop the run]
  while pgrep -fai 'mount_sonata|Sonata.AppImage' | grep -qv claude-scratch || pgrep -f 'steamapps/common|proton' >/dev/null ||
    nvidia-smi --query-compute-apps=used_memory --format=csv,noheader,nounits | awk '$1 > 1024 {f=1} END {exit !f}'; do
    echo "GPU busy (Sonata, a game or another process): waiting $(date +%T)"
    # loop: SERIAL-REQUIRED — the poll's one-minute pause [bounded: 60 s]
    sleep 60
  done
}
case $STEP in
  torch) $LOCK "$D/run.sh" 12G parity_patch.py --onnx5 256x384x2 384x640x2 512x896x2 768x1280x4 | tee "$OUT/torch.log" ;;
  net)
    # loop: SERIAL-REQUIRED — two precisions, one capped run at a time
    for prec in fp32 fp16; do
      pieces=stage2,stage1; [ $prec = fp16 ] && pieces=cradio,$pieces
      $LOCK "$D/run.sh" 14G net_parity.py "$OLD" "$NEW" --prec $prec --pieces $pieces 256x384x2 384x640x4 768x1280x4 \
        | tee "$OUT/net-$prec.log"
    done ;;
  cuda)
    pgrep -fai 'mount_sonata|Sonata.AppImage' | grep -v claude-scratch && { echo "Sonata is running: no GPU work"; exit 1; }
    $LOCK env CK_GPU=0 LD_LIBRARY_PATH="$LD" "$D/run.sh" 16G net_parity.py "$OLD" "$NEW" --prec fp16 --ep cuda 1152x1920x8 2176x3840x4 | tee "$OUT/cuda.log" ;;
  engine|cpu)
    if [ $STEP = cpu ]; then  # the procedural 320x200 "tiny" clip (make_clip.py), a PNG frame folder
      [ -d "$OUT/tiny/rgb" ] || "$D/run.sh" 4G make_clip.py "$OUT/tiny" 320 200 8
      clips=("$OUT/tiny/rgb"); dev=(--device cpu --cpu --stall-s 3600)
    else clips=("$T"/*.mov "$T"/4k/04_5h "$T"/4k/04_5d "$T"/4k/08_3a "$T"/4k/04_2c); dev=(--device cuda); fi
    # loop: SERIAL-REQUIRED — one clip at a time, both sets back to back (same GPU state), one engine run at a time
    for c in "${clips[@]}"; do
      n=$(basename "$c"); n=${n%.*}
      # loop: SERIAL-REQUIRED — the two sets, one engine run at a time (one GPU job)
      for set in old new; do
        [ -f "$OUT/$STEP-$set/$n/bench.json" ] && continue  # a re-run picks up where it stopped
        [ $STEP = engine ] && wait_gpu
        models=$([ $set = old ] && echo "$OLD" || echo "$NEW")
        $LOCK "$S/tools/memrun.sh" 18 node "$REPO/tools/engine_bench.mjs" rust --bin "$ENGINE" --models "$models" --ort "$ORT" \
          --env "LD_LIBRARY_PATH=$LD" "${dev[@]}" --out "$OUT/$STEP-$set/$n" --option 'output_format="exr"' \
          --option 'exr_dtype="float"' "$c"
      done
      $LOCK "$PY" -I "$REPO/tools/matte_compare.py" "$OUT/$STEP-old/$n/out/$n" "$OUT/$STEP-new/$n/out/$n" \
        --json "$OUT/$STEP-$n-matte.json" --md "$OUT/$STEP-$n-matte.md"
      # loop: NOT-WORTH — two sets, one stability pass each
      for set in old new; do
        $LOCK "$PY" -I "$REPO/tools/temporal_stability.py" "$OUT/$STEP-$set/$n/out/$n" --input "$c" \
          --json "$OUT/$STEP-$set-$n-stability.json"
      done
      rm -rf "$OUT/$STEP-old/$n/out" "$OUT/$STEP-new/$n/out"  # float EXR: up to ~30 GB per 4K plate and set
    done ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 2 ;;
esac
