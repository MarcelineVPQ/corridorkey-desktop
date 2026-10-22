#!/usr/bin/env bash
# End-to-end check of corridorkey-engine on ONNX Runtime's CPU provider at tiny size (no GPU), memory-capped
# by a guard that stops the engine itself before the kernel would (CK_MEMRUN: `memrun.sh <GB> <cmd...>`;
# Marcy's machine: ~/.cache/claude-scratch/tools/memrun.sh).
#
#   engine-rs/tools/e2e_cpu.sh MODELS_DIR CLIP_DIR REF_NPZ [WORK_DIR]
#
# MODELS_DIR: the five fp32 ONNX networks; CLIP_DIR: a clip folder with rgb/ (frames) and alpha/ (16-bit
# ground-truth mattes), e.g. the ONNX spike's clips/tiny; REF_NPZ: the PyTorch fp32 run of the same clip at
# window 4/2 (the spike's run_parity.py torch output). Runs one engine process with four jobs:
#   p1  frame folder, window 4/2, EXR float, alpha+fg      -> parity against REF_NPZ (thresholds below)
#   p2  the same in staged low-VRAM mode                     -> must equal p1
#   v1  the clip as H.264, all four outputs, first-frame hint, automatic window
#   v2  the clip as H.264 with a hint video, EXR half, linear cutout
# Exit 0 only when every job finished and p1 / p2 pass.
set -euo pipefail
MODELS=$1 CLIP=$2 REF=$3
WORK=${4:-$HOME/.cache/claude-scratch/corridorkey-rust/e2e}
HERE=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${CK_ENGINE_BIN:-${CARGO_TARGET_DIR:-$HERE/engine-rs/target}/release/corridorkey-engine}
rm -rf "$WORK/out" "$WORK/tmp" && mkdir -p "$WORK/in" "$WORK/out" "$WORK/tmp"

# inputs: the frames as H.264 (yuv420p, BT.709 tags) and the ground-truth matte as a hint video
ffmpeg -v error -y -framerate 24 -i "$CLIP/rgb/%05d.png" -c:v libx264 -pix_fmt yuv420p -crf 16 \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 "$WORK/in/tiny.mp4"
ffmpeg -v error -y -framerate 24 -i "$CLIP/alpha/%05d.png" -c:v libx264 -pix_fmt yuv420p -crf 16 "$WORK/in/tiny_hint.mp4"

job() { # id input options-json
  printf '{"cmd":"run","id":"%s","input":"%s","output_dir":"%s","temp_dir":"%s","options":%s}\n' "$1" "$2" "$WORK/out/$1" "$WORK/tmp/$1" "$3"
}
{
  echo '{"cmd":"ping"}'
  job p1 "$CLIP/rgb" '{"hann_chunk":4,"hann_stride":2,"output_format":"exr","exr_dtype":"float","outputs":["alpha","fg"]}'
  job p2 "$CLIP/rgb" '{"hann_chunk":4,"hann_stride":2,"low_vram":true,"output_format":"exr","exr_dtype":"float","outputs":["alpha","fg"]}'
  job v1 "$WORK/in/tiny.mp4" "{\"outputs\":[\"alpha\",\"fg\",\"checker\",\"cutout\"],\"hint_first_frame\":\"$CLIP/alpha/00000.png\"}"
  job v2 "$WORK/in/tiny.mp4" "{\"hann_chunk\":4,\"hann_stride\":2,\"hint_video\":\"$WORK/in/tiny_hint.mp4\",\"output_format\":\"exr\",\"outputs\":[\"alpha\",\"cutout\"],\"cutout_linear\":true}"
  echo '{"cmd":"quit"}'
} > "$WORK/requests.jsonl"

MEMRUN=${CK_MEMRUN:-$HOME/.cache/claude-scratch/tools/memrun.sh}
[ -x "$MEMRUN" ] || { echo "no memory guard: set CK_MEMRUN to a memrun.sh-style wrapper" >&2; exit 2; }
# the redirections happen inside the guarded command (a background job's own stdin is /dev/null)
"$MEMRUN" 8 bash -c 'exec env CUDA_VISIBLE_DEVICES= /usr/bin/time -v -o "$1/time.txt" "$2" --models "$3" --device cpu < "$1/requests.jsonl" > "$1/replies.jsonl" 2> "$1/stderr.log"' \
  _ "$WORK" "$BIN" "$MODELS"
grep -E "Maximum resident|Elapsed" "$WORK/time.txt"

python3 -I - "$WORK/replies.jsonl" <<'EOF'
import json, sys
rs = [json.loads(l) for l in open(sys.argv[1])]
ok = True
# loop: NOT-WORTH — four test jobs
for j in ("p1", "p2", "v1", "v2"):
    end = [r for r in rs if r.get("id") == j and r["type"] in ("result", "error")]
    mem = [r for r in rs if r.get("id") == j and r["type"] == "memory"]
    print(j, end[-1]["type"] if end else "NO REPLY", (end[-1].get("seconds") or end[-1].get("message")) if end else "", mem[-1] if mem else "")
    ok &= bool(end) and end[-1]["type"] == "result"
sys.exit(0 if ok else 1)
EOF

python3 -I "$HERE/tools/matte_compare.py" "$REF" "$WORK/out/p1" --json "$WORK/p1_vs_ref.json" | grep -v COMPARE
python3 -I "$HERE/tools/matte_compare.py" "$WORK/out/p1" "$WORK/out/p2" --json "$WORK/p2_vs_p1.json" | grep -v COMPARE
python3 -I - "$WORK" <<'EOF'
import json, sys
w = sys.argv[1]
p1 = json.load(open(f"{w}/p1_vs_ref.json"))[0]
p2 = json.load(open(f"{w}/p2_vs_p1.json"))[0]
# fp32 parity with PyTorch fp32 (the ONNX spike measured alpha MAE 2.2e-7, max 1.7e-4 for ORT fp32 in Python)
checks = [("p1 alpha MAE < 1e-6", p1["alpha_mae"] < 1e-6), ("p1 alpha max < 1e-3", p1["alpha_max"] < 1e-3),
          ("p1 no pixel > 1/255", p1["alpha_pct_gt_1_255"] == 0), ("p1 fg PSNR > 90 dB", p1["fg_psnr_db"] > 90),
          ("p2 (low VRAM) alpha max < 1e-5", p2["alpha_max"] < 1e-5)]
# loop: NOT-WORTH — five checks
for name, good in checks:
    print(("PASS " if good else "FAIL ") + name)
sys.exit(0 if all(g for _, g in checks) else 1)
EOF
