#!/usr/bin/env bash
# End-to-end check of the model scale, the linear adjust and the start mode (backlog rows 42 and 45): the engine on
# ONNX Runtime's CPU provider (fp32) against the original runtime itself on the CPU in float32
# (tools/ref_original_cpu.py: upstream's run_inference, its output resize completed with upstream's own Lanczos
# helper). No GPU; every run memory-capped (CK_MEMRUN: `memrun.sh <GB> <cmd...>`).
#
#   engine-rs/tools/e2e_scale_cpu.sh MODELS_DIR CLIP_DIR CK2_ROOT [WORK_DIR]
#
# MODELS_DIR: the five fp32 ONNX networks; CLIP_DIR: a clip folder with rgb/ (12 frames of 448x320 PNGs, e.g.
# export/make_clip.py OUT 448 320 12); CK2_ROOT: a CorridorKey2.0 checkout with its venv. Four jobs, window 4/2, EXR float:
#   s1  the clip as H.264, model_scale 0.5, the first 8 frames            (448x320 -> 224x160, padded 256x256)
#   s2  the same at model_scale 1.0 with linear brightness 1.4, contrast 1.2, pivot 0.18
#   s3  the frame folder, model_scale 0.75                                (-> 336x240, padded 384x256)
#   s4  H.264, model_scale 0.5, num_frames 6, start_mode random_middle, seed 3 (start frame from NumPy's generator)
# matte_compare runs with CK_COMPARE_PY (a python with numpy, OpenCV and OpenEXR; default python3).
# Exit 0 only when every job finished on both sides and each pair passes the thresholds of tools/e2e_cpu.sh.
set -euo pipefail
MODELS=$1 CLIP=$2 CK2=$3
WORK=${4:-$HOME/.cache/claude-scratch/corridorkey-rust/e2e-scale}
HERE=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${CK_ENGINE_BIN:-${CARGO_TARGET_DIR:-$HERE/engine-rs/target}/release/corridorkey-engine}
MEMRUN=${CK_MEMRUN:-$HOME/.cache/claude-scratch/tools/memrun.sh}
[ -x "$MEMRUN" ] || { echo "no memory guard: set CK_MEMRUN to a memrun.sh-style wrapper" >&2; exit 2; }
rm -rf "$WORK/out" "$WORK/ref" "$WORK/tmp" && mkdir -p "$WORK/in" "$WORK/out" "$WORK/ref" "$WORK/tmp"
ffmpeg -v error -y -framerate 24 -i "$CLIP/rgb/%05d.png" -c:v libx264 -pix_fmt yuv420p -crf 16 \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 "$WORK/in/clip.mp4"

# id input engine-options-json reference-args
JOBS=(
  "s1|$WORK/in/clip.mp4|{\"model_scale\":0.5,\"num_frames\":8}|--model_scale 0.5 --num_frames 8"
  "s2|$WORK/in/clip.mp4|{\"linear_brightness\":1.4,\"linear_contrast\":1.2,\"linear_contrast_pivot\":0.18,\"num_frames\":8}|--linear_brightness 1.4 --linear_contrast 1.2 --linear_contrast_pivot 0.18 --num_frames 8"
  "s3|$CLIP/rgb|{\"model_scale\":0.75,\"num_frames\":8}|--model_scale 0.75 --num_frames 8"
  "s4|$WORK/in/clip.mp4|{\"model_scale\":0.5,\"num_frames\":6,\"start_mode\":\"random_middle\",\"seed\":3}|--model_scale 0.5 --num_frames 6 --start_mode random_middle --seed 3"
)
BASE='"hann_chunk":4,"hann_stride":2,"output_format":"exr","exr_dtype":"float","outputs":["alpha","fg"]'
{
  echo '{"cmd":"ping"}'
  # loop: NOT-WORTH — four test jobs
  for j in "${JOBS[@]}"; do
    IFS='|' read -r id input opts _ <<< "$j"
    o="${opts%\}},${BASE}}"
    printf '{"cmd":"run","id":"%s","input":"%s","output_dir":"%s","temp_dir":"%s","options":%s}\n' "$id" "$input" "$WORK/out/$id" "$WORK/tmp/$id" "$o"
  done
  echo '{"cmd":"quit"}'
} > "$WORK/requests.jsonl"
"$MEMRUN" 8 bash -c 'exec env CUDA_VISIBLE_DEVICES= "$2" --models "$3" --device cpu < "$1/requests.jsonl" > "$1/replies.jsonl" 2> "$1/stderr.log"' \
  _ "$WORK" "$BIN" "$MODELS"

# loop: NOT-WORTH — four reference runs, one at a time
for j in "${JOBS[@]}"; do
  IFS='|' read -r id input _ refargs <<< "$j"
  # shellcheck disable=SC2086
  "$MEMRUN" 12 "$CK2/venv/bin/python" -I "$HERE/engine-rs/tools/ref_original_cpu.py" "$CK2" "$input" "$WORK/ref/$id" "$WORK/tmp/ref_$id" $refargs \
    > "$WORK/ref_$id.log" 2>&1 || { echo "reference $id failed:"; tail -5 "$WORK/ref_$id.log"; exit 1; }
done

python3 -I - "$WORK" <<'EOF'
import json, sys
rs = [json.loads(l) for l in open(f"{sys.argv[1]}/replies.jsonl")]
ok = True
# loop: NOT-WORTH — four test jobs
for j in ("s1", "s2", "s3", "s4"):
    end = [r for r in rs if r.get("id") == j and r["type"] in ("result", "error")]
    print(j, end[-1]["type"] if end else "NO REPLY", (end[-1].get("seconds") or end[-1].get("message")) if end else "")
    ok &= bool(end) and end[-1]["type"] == "result"
sys.exit(0 if ok else 1)
EOF

fail=0
# loop: NOT-WORTH — four comparisons
for id in s1 s2 s3 s4; do
  "${CK_COMPARE_PY:-python3}" -I "$HERE/tools/matte_compare.py" "$WORK/ref/$id" "$WORK/out/$id" --json "$WORK/${id}_vs_ref.json" | grep -v COMPARE
  python3 -I - "$WORK/${id}_vs_ref.json" "$id" <<'EOF' || fail=1
import json, sys
r = json.load(open(sys.argv[1]))[0]
checks = [("alpha MAE < 1e-6", r["alpha_mae"] < 1e-6), ("alpha max < 1e-3", r["alpha_max"] < 1e-3),
          ("no pixel > 1/255", r["alpha_pct_gt_1_255"] == 0), ("fg PSNR > 90 dB", r["fg_psnr_db"] > 90)]
# loop: NOT-WORTH — four checks
for name, good in checks:
    print(("PASS " if good else "FAIL ") + sys.argv[2] + " " + name)
sys.exit(0 if all(g for _, g in checks) else 1)
EOF
done
grep -h "Start Frame\|Model Scale\|Linear Brightness" "$WORK/out/s4/"*_settings.txt "$WORK/out/s2/"*_settings.txt || true
exit $fail
