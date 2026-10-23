#!/bin/bash
# Run a spike script with a host-memory limit. usage: run.sh MEM script.py args...
# MEM like 16G or 16. Goes through ~/.cache/claude-scratch/tools/memrun.sh, which
# stops the job itself at 90% of the limit (exit 137, "memrun: stopped at N GB"),
# so the kernel never OOM-kills it. A memrun stop is a result: never rerun it as is.
MEM=${1%G}; shift
source $HOME/.cache/claude-scratch/corridorkey-onnx/venv/bin/activate
cd "$(dirname "$(readlink -f "$0")")"
export LD_LIBRARY_PATH=$HOME/.cache/claude-scratch/corridorkey-onnx/venv/lib/python3.12/site-packages/tensorrt_libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
export CUDA_VISIBLE_DEVICES=${CK_GPU:-""} HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONWARNINGS=ignore
exec $HOME/.cache/claude-scratch/tools/memrun.sh "$MEM" python "$@"
