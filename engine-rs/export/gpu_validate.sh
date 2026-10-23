#!/bin/bash
# GPU validation of the production ONNX set (not a speed benchmark):
#   fp16/fp32 non-finite counts on CUDA, parity vs a PyTorch fp32 CUDA reference
#   (upstream low-VRAM path, exact), and peak VRAM of the mask-free attention
#   graph vs the spike's masked opset-23 fp16 graph
#   (default session options, as the Rust engine loads them).
# Every run goes through gpu_guard.py: refuses to start (exit 75) if Sonata runs
# or another process holds > 1 GiB VRAM, and aborts within 2 s if Sonata starts.
# Host memory: memrun.sh 16G per run (stops itself at 90%, exit 137); VRAM: <= 12 GiB per
# process (per-session ORT gpu_mem_limit + guard exit 76). Both are recorded, never retried.
# Resumable: steps with an existing result or a recorded failure are skipped.
# usage: gpu_validate.sh [clip...]   (default: gs720 gs1080)
S=$HOME/.cache/claude-scratch/corridorkey-onnx
RUN="$(dirname "$0")/run.sh"
R=$S/results/gpu
mkdir -p $R
LOG=$R/validate.log
export CK_GPU=0
clips=${@:-gs720 gs1080}
step() {  # name, args...
  local name=$1; shift
  if [ -f "$3" ]; then echo "SKIP $name: result exists" >> $LOG; return 0; fi
  if grep -qE "^(MEMRUN-STOP|VRAM-CAP|FAIL) $name[ :]" $LOG 2>/dev/null; then echo "SKIP $name: recorded failure, not retried" >> $LOG; return 0; fi
  avail=$(free -g | awk '/Mem:/{print $7}')
  if [ "$avail" -lt 8 ]; then echo "SKIP $name: host available ${avail}G < 8G" | tee -a $LOG; return 0; fi
  echo "=== $name $(date +%T)" | tee -a $LOG
  "$RUN" 16G run_parity.py "$@" > $R/$name.log 2>&1
  rc=$?
  grep -E "^RUN|GPU_GUARD" $R/$name.log | tee -a $LOG
  if [ $rc -eq 75 ]; then echo "STOP: GPU guard" | tee -a $LOG; exit 75; fi
  if [ $rc -eq 137 ]; then echo "MEMRUN-STOP $name (host limit 16G): $(grep memrun: $R/$name.log | head -1) - not retried" | tee -a $LOG; return 0; fi
  if [ $rc -eq 76 ]; then echo "VRAM-CAP $name: $(grep GPU_GUARD $R/$name.log | tail -1) - not retried" | tee -a $LOG; return 0; fi
  if [ $rc -ne 0 ]; then
    echo "FAIL $name rc=$rc $(grep -v '^\s' $R/$name.log | grep -iE 'error|fail|out of memory' | tail -1 | cut -c1-300)" | tee -a $LOG
  fi
}
for c in $clips; do
  for w in "8 4" "24 12"; do
    set -- $w; ch=$1; st=$2; tag=${c}_${ch}x${st}
    common="--frames 48 --chunk $ch --stride $st"
    step torch_fp32_$tag torch $S/clips/$c/rgb $R/torch_fp32_$tag.npz --device cuda --amp fp32 --low-vram $common
    step prod_fp16_$tag ort $S/clips/$c/rgb $R/prod_fp16_$tag.npz --ep cuda --onnx-set prod_fp16 $common --warmup
    step prod_fp32_$tag ort $S/clips/$c/rgb $R/prod_fp32_$tag.npz --ep cuda --onnx-set prod_fp32 $common --warmup
    step spike_fp16_$tag ort $S/clips/$c/rgb $R/spike_fp16_$tag.npz --ep cuda --onnx-set fp16 $common
  done
done
# Parity tables (CPU only) against the PyTorch fp32 reference of the same clip/window.
export CK_GPU=""
for f in $R/prod_*.npz $R/spike_*.npz; do
  [ -f "$f" ] || continue
  tag=$(basename $f .npz | grep -oE "gs[0-9]+_[0-9]+x[0-9]+")
  [ -f $R/torch_fp32_$tag.npz ] && "$RUN" 8G run_parity.py cmp $R/torch_fp32_$tag.npz $f $S/clips/${tag%%_*}/alpha \
    | grep PARITY | tee -a $LOG
done
echo "DONE $(date +%T)" | tee -a $LOG
