#!/bin/bash
# Run a spike script with a host-memory limit. usage: run.sh MEM script.py args...
# MEM like 16G or 16. Goes through memrun.sh (CK_MEMRUN), which
# stops the job itself at 90% of the limit (exit 137, "memrun: stopped at N GB"),
# so the kernel never OOM-kills it. A memrun stop is a result: never rerun it as is.
# Paths (docs/ONNX_EXPORT.md): CK_ONNX_SCRATCH (default ~/.cache/claude-scratch/corridorkey-onnx), CK_ONNX_VENV
# (default <scratch>/venv), CK_MEMRUN (default ~/.cache/claude-scratch/tools/memrun.sh).
MEM=${1%G}; shift
export CK_ONNX_SCRATCH=${CK_ONNX_SCRATCH:-$HOME/.cache/claude-scratch/corridorkey-onnx}
VENV=${CK_ONNX_VENV:-$CK_ONNX_SCRATCH/venv}
source "$VENV/bin/activate"
cd "$(dirname "$(readlink -f "$0")")"
TRT_LIBS=$(python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')/tensorrt_libs
export LD_LIBRARY_PATH=$TRT_LIBS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
export CUDA_VISIBLE_DEVICES=${CK_GPU:-""} HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONWARNINGS=ignore
exec "${CK_MEMRUN:-$HOME/.cache/claude-scratch/tools/memrun.sh}" "$MEM" python "$@"
