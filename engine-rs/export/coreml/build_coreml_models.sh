#!/usr/bin/env bash
# The Core ML model set, phase 1 (BACKLOG row 24): fixed-shape copies of the shipped fp16 networks, rewritten so
# ONNX Runtime's Core ML execution provider (ML Program) takes every node (the Core ML feasibility study,
# 2026-10-24). One file per network, padded size and batch:
#   ck2-<piece>-fp16-coreml-<H>x<W>-t<T>.onnx
# Each file keeps its weights in the shipped set's ck2-<piece>-fp16.onnx.data (same name, same offsets): the files
# go into the shipped set's folder next to it, with coreml.json, which the engine reads for --device coreml.
#
#   build_coreml_models.sh SET_DIR OUT_DIR HxW PIECE:T [PIECE:T ...]
#   e.g. build_coreml_models.sh ~/.local/share/corridorkey-desktop/models/2.0.0-onnx.4 OUT 1152x1280 \
#          cradio:4 moge:4 rvm:1 stage1:4 stage1:8 stage2:1
#
# Steps per file (all CPU; ONNX Runtime's CPU kernels evaluate the folded constants, so folding is exact):
#   fix_shapes.py (fixed input dims) -> fold.py (shape paths and constant branches folded) -> coreml_rewrites.py
#   (attention -> plain ops, RMSNorm decomposed in fp32, MoGe's antialiased resize -> matrices, Expand -> Tile,
#   rank lowering to <= 5-D) -> ep_probe.py (ORT's real Core ML partitioner; a Linux build of ORT 1.31 with the
#   Core ML EP says how many nodes and partitions Core ML takes; it can't compile or run the model).
# Python: PY (default the Core ML study's venv: onnx 1.23 + ONNX Runtime 1.31 with the Core ML EP compiled in).
# Memory: each step in its own capped scope (CK_MEMRUN, default ~/.cache/claude-scratch/tools/memrun.sh, 12 GB),
# one at a time under ~/.cache/claude-scratch/heavy.lock when that exists.
set -euo pipefail
[ $# -ge 4 ] || { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 2; }
SET=$(cd "$1" && pwd) OUT=$2 SHAPE=$3; shift 3
[[ "$SHAPE" =~ ^([0-9]+)x([0-9]+)$ ]] || { echo "shape wants HxW" >&2; exit 2; }
H=${BASH_REMATCH[1]} W=${BASH_REMATCH[2]}
HERE=$(cd "$(dirname "$0")" && pwd)
PY=${PY:-$HOME/.cache/claude-scratch/ck-mac/bvenv/bin/python}
MEMRUN=${CK_MEMRUN:-$HOME/.cache/claude-scratch/tools/memrun.sh}
LOCK=$HOME/.cache/claude-scratch/heavy.lock
export CUDA_VISIBLE_DEVICES=
mkdir -p "$OUT/build" "$OUT/probe"
OUT=$(cd "$OUT" && pwd)
B=$OUT/build
capped() { # one capped, locked step
  if [ -x "$MEMRUN" ]; then
    if [ -e "$LOCK" ]; then flock "$LOCK" "$MEMRUN" 12 "$@"; else "$MEMRUN" 12 "$@"; fi
  else
    systemd-run --user --scope --quiet --collect ${CK_SLICE:+--slice=$CK_SLICE} -p MemoryMax=12G -p MemorySwapMax=0 -- "$@"
  fi
}
# the shipped fp16 files, copied (onnx won't follow hard links to external data), checked against manifest.json
# loop: NOT-WORTH — the pieces asked for (≤ 5 distinct)
for pt in "$@"; do
  p=${pt%%:*}
  for f in "ck2-$p-fp16.onnx" "ck2-$p-fp16.onnx.data"; do
    [ -f "$B/$f" ] || cp "$SET/$f" "$B/$f"
  done
done
"$PY" -I - "$SET/manifest.json" "$B" <<'PYEOF'
import hashlib, json, os, sys
man, d = sys.argv[1:3]
want = {f["file"]: f["sha256"] for m in json.load(open(man))["models"] for f in m["files"]}
# loop: NOT-WORTH — ≤ 10 files, each hashed once
for name in sorted(os.listdir(d)):
    if name in want:
        h = hashlib.sha256()
        with open(os.path.join(d, name), "rb") as fh:
            # loop: SERIAL-REQUIRED — 16 MB reads of one file [bounded: the file's size]
            for b in iter(lambda: fh.read(1 << 24), b""):
                h.update(b)
        assert h.hexdigest() == want[name], f"{name}: not the shipped file"
print("source files match the shipped manifest")
PYEOF
# the scripts read external weights relative to the working folder
cd "$B"
# loop: SERIAL-REQUIRED — one network at a time (each step capped and under the heavy lock)
for pt in "$@"; do
  p=${pt%%:*} t=${pt##*:}
  src=$B/ck2-$p-fp16.onnx
  tag=$H"x"$W-t$t
  dst=$B/ck2-$p-fp16-coreml-$tag.onnx
  echo "== $p at $tag"
  t0=$(date +%s)
  "$PY" -I "$HERE/fix_shapes.py" "$src" "$B/ck2-$p-fp16-$tag-fix.onnx" "$H" "$W" "$t" >/dev/null
  capped "$PY" -I "$HERE/fold.py" "$B/ck2-$p-fp16-$tag-fix.onnx" "$B/ck2-$p-fp16-$tag-fold.onnx"
  capped "$PY" -I "$HERE/coreml_rewrites.py" "$B/ck2-$p-fp16-$tag-fold.onnx" "$dst" >"$OUT/probe/$p-$tag-rw.txt" 2>&1 \
    || { tail -20 "$OUT/probe/$p-$tag-rw.txt" >&2; exit 1; }
  grep -v "^RANK_LOWER skip" "$OUT/probe/$p-$tag-rw.txt" | tail -2
  rm -f "$B/ck2-$p-fp16-$tag-fix.onnx" "$B/ck2-$p-fp16-$tag-fold.onnx"
  COREML_PROBE_CACHE=$OUT/probe/cache-$p-$tag capped "$PY" -I "$HERE/ep_probe.py" "$dst" >"$OUT/probe/$p-$tag-cm.log" 2>&1 || true
  "$PY" -I "$HERE/parse_probe.py" "$OUT/probe/$p-$tag-cm.log" | cut -c1-300
  rm -rf "$OUT/probe/cache-$p-$tag"
  echo "   $(( $(date +%s) - t0 )) s"
done
# the set folder: the files, coreml.json, SHA256SUMS (weights checked to be the shipped .onnx.data files);
# tools/mac_gate.sh --coreml-set OUT/set copies it next to the shipped set on the Mac
"$PY" -I "$HERE/write_set.py" "$B" "$OUT/set" "$SET"
