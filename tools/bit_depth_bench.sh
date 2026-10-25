#!/usr/bin/env bash
# Deep input (BACKLOG row 27, README "Deep input"): what a 10/12-bit plate loses when it is decoded at 8 bits,
# and proof that the 16-bit decode is exact. Reproduces the README table.
#
#   tools/bit_depth_bench.sh --old-engine BIN --new-engine BIN [--plate DIR] [--out DIR]
#
#   --old-engine  an engine built before deep input (commit 5a89777^): it decodes all video at 8 bits
#                 (git worktree add /tmp/ck-old 5a89777^ && (cd /tmp/ck-old && tools/build_engine.sh))
#   --new-engine  an engine with deep input (5a89777 or later; tools/build_engine.sh). Since 2026-10-25 deep input is
#                 opt-in (`input_bit_depth` 16; the default reads as CorridorKey 2.0 does, at 8 bits): the new engine's
#                 runs here ask for it. A current engine also serves as --old-engine (its default is the 8-bit read)
#   --plate       a scene-linear EXR sequence (default ~/Videos/corridorkey-tests/4k/04_5d, the Tears of Steel plate)
#   --out         the work folder (default ~/.cache/claude-scratch/bit-depth-bench; about 45 GB at 4K, 120 frames)
#
# Steps:
#   1. the plate, display-encoded (sRGB) to 16-bit PNG frames (OpenCV float read, never ffmpeg's EXR path)
#   2. two deep videos from it: ProRes 4444 XQ 10-bit (prores_ks) and HEVC 4:4:4 12-bit (libx265, crf 4), 24 fps
#   3. the reference for each: the video decoded to 16-bit PNG frames, i.e. exactly the values the video holds
#   4. keyed three times per video with the same CUDA runtime, models and settings, EXR outputs:
#      old engine (8-bit decode), new engine (16-bit decode), new engine on the reference frames
#   5. tools/matte_compare.py (exact: EXR as float): each decode against its reference, into <out>/results.md
# GPU: refuses while Marcy's Sonata runs and holds ~/.cache/claude-scratch/gpu.lock for the keying (rule 11).
# Memory: every step runs in its own capped scope (systemd-run; CK_SLICE joins a shared budget, CLAUDE.md).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
OLD="" NEW="" PLATE="$HOME/Videos/corridorkey-tests/4k/04_5d" OUT="$HOME/.cache/claude-scratch/bit-depth-bench"
# loop: NOT-WORTH — the command-line options
while [ $# -gt 0 ]; do
  case "$1" in
    --old-engine) OLD="$2"; shift 2 ;;
    --new-engine) NEW="$2"; shift 2 ;;
    --plate) PLATE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
die() { echo "STOP: $*" >&2; exit 1; }
[ -x "$OLD" ] && [ -x "$NEW" ] || die "--old-engine and --new-engine must be executables"
[ -d "$PLATE" ] || die "no plate folder: $PLATE"
PY="${CK_PYTHON:-python3}"
"$PY" -I -c "import cv2, numpy" 2>/dev/null || die "$PY needs numpy and OpenCV (set CK_PYTHON to a venv's python)"
DATA="$HOME/.local/share/corridorkey-desktop"
RT="$(ls -d "$DATA"/runtime/ort-*-cuda* 2>/dev/null | tail -1)"
MODELS="$(ls -d "$DATA"/models/*/ 2>/dev/null | tail -1)"
[ -n "$RT" ] && [ -n "$MODELS" ] || die "the app's runtime and models aren't installed ($DATA)"
ORT="$(ls "$RT"/onnxruntime/capi/libonnxruntime.so.* | head -1)"
LIBS="$RT/onnxruntime/capi:$RT/nvidia/cu13/lib:$RT/nvidia/cudnn/lib"
cap() { local gb="$1"; shift; systemd-run --user --scope --quiet --collect ${CK_SLICE:+--slice=$CK_SLICE} -p MemoryMax="${gb}G" -p MemorySwapMax=0 -- "$@"; }
mkdir -p "$OUT"

echo "== plate → 16-bit PNG ($(date +%T))"
rm -rf "$OUT/png_src" "$OUT/in" "$OUT/runs"; mkdir -p "$OUT/png_src"
cap 6 "$PY" -I - "$PLATE" "$OUT/png_src" <<'EOF'
import glob, os, sys
os.environ["OPENCV_IO_ENABLE_OPENEXR"] = "1"
import cv2, numpy as np
src, dst = sys.argv[1], sys.argv[2]
# loop: SERIAL-REQUIRED — one 4K frame at a time (memory), each read, encoded and written once
for i, f in enumerate(sorted(glob.glob(os.path.join(glob.escape(src), "*.exr")))):
    x = np.clip(np.maximum(cv2.imread(f, cv2.IMREAD_UNCHANGED)[..., :3].astype(np.float64), 0), 0, 1)
    x = np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)
    cv2.imwrite(os.path.join(dst, f"{i:05d}.png"), (x * 65535 + 0.5).astype(np.uint16))
EOF
N="$(ls "$OUT/png_src" | wc -l)"; [ "$N" -gt 0 ] || die "no frames written from $PLATE"

echo "== deep videos and their 16-bit references ($(date +%T))"
mkdir -p "$OUT/in/prores" "$OUT/in/hevc" "$OUT/in/prores_ref/plate" "$OUT/in/hevc_ref/plate"
cap 10 ffmpeg -v error -nostdin -y -framerate 24 -i "$OUT/png_src/%05d.png" -c:v prores_ks -profile:v 5 -pix_fmt yuv444p10le "$OUT/in/prores/plate.mov"
# x265 at 4K 4:4:4: fewer frame threads and a short lookahead keep it near 5 GB
cap 10 ffmpeg -v error -nostdin -y -framerate 24 -i "$OUT/png_src/%05d.png" -c:v libx265 \
  -x265-params log-level=error:frame-threads=1:pools=8:rc-lookahead=10:lookahead-slices=0 -crf 4 -pix_fmt yuv444p12le "$OUT/in/hevc/plate.mkv"
# loop: NOT-WORTH — two videos
for v in prores hevc; do
  f="$(ls "$OUT/in/$v"/plate.*)"
  cap 10 ffmpeg -v error -nostdin -y -threads 4 -i "$f" -threads 4 -pix_fmt rgb48be "$OUT/in/${v}_ref/plate/%05d.png"
  [ "$(ls "$OUT/in/${v}_ref/plate" | wc -l)" = "$N" ] || die "$v reference: not $N frames"
done
rm -rf "$OUT/png_src"

echo "== keying ($(date +%T))"
if pgrep -fai 'mount_sonata|Sonata.AppImage' > /dev/null; then die "Sonata is running: no GPU work while it plays"; fi
exec 9> "$HOME/.cache/claude-scratch/gpu.lock"; flock 9
key() { # engine run-name input [engine_bench options...]
  local bin="$1" run="$2" input="$3"; shift 3
  cap 16 env NODE_OPTIONS=--max-old-space-size=2048 node "$here/tools/engine_bench.mjs" rust --bin "$bin" --device cuda \
    --models "$MODELS" --ort "$ORT" --env LD_LIBRARY_PATH="$LIBS" --option output_format=\"exr\" "$@" --out "$OUT/runs/$run" "$input" \
    > "$OUT/runs-$run.log" 2>&1 || die "$run: engine_bench failed (see $OUT/runs-$run.log)"
  [ -d "$OUT/runs/$run/out/plate" ] || die "$run: no outputs"
}
DEEP=(--option input_bit_depth=\"16\")
# loop: SERIAL-REQUIRED — one GPU job at a time
for v in prores hevc; do
  f="$(ls "$OUT/in/$v"/plate.*)"
  key "$OLD" "${v}8" "$f"; key "$NEW" "${v}16" "$f" "${DEEP[@]}"; key "$NEW" "${v}ref" "$OUT/in/${v}_ref/plate" "${DEEP[@]}"
done
exec 9>&-

echo "== exact comparisons ($(date +%T))"
: > "$OUT/results.md"
# loop: NOT-WORTH — four comparisons
for run in prores8 prores16 hevc8 hevc16; do
  ref="${run%%[0-9]*}ref"
  cap 8 "$PY" -I "$here/tools/matte_compare.py" "$OUT/runs/$ref/out/plate" "$OUT/runs/$run/out/plate" \
    --json "$OUT/$run.json" --md "$OUT/$run.md" > /dev/null
  { echo "## $run vs $ref"; cat "$OUT/$run.md"; "$PY" -I -c "import json,sys; d=json.load(open(sys.argv[1])); d=d[0] if isinstance(d, list) else d; print('hair-edge band: MAE', d.get('edge_band_mae'), '· % > 1/255', d.get('edge_band_pct_gt_1_255'))" "$OUT/$run.json"; echo; } >> "$OUT/results.md"
done
echo "== done ($(date +%T)): $OUT/results.md"
cat "$OUT/results.md"
