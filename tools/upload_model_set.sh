#!/usr/bin/env bash
# Publish a TensorRT or Core ML model set as this repository's GitHub release `models-<set>` (the app downloads it by
# exact name, size and SHA-256: electron/main/install.ts TENSORRT.models, and COREML on macOS).
#
#   tools/upload_model_set.sh DIR SET     SET: e.g. 2.0.0-onnx.5-trt or 2.0.0-onnx.5-coreml
#
# DIR holds the set as its build writes it. TensorRT (`-trt`, engine-rs/export/build_trt_models.sh):
# ck2-*-trt-fp16.onnx, their .onnx.data, the -ctx.onnx EPContext stubs, and models.json. Core ML (`-coreml`,
# engine-rs/export/coreml/build_coreml_models.sh's OUT/set): ck2-*-fp16-coreml-*.onnx and coreml.json (their weights
# are the model set's own .onnx.data, not in this release). Both also get the base set's licence and attribution
# files (ATTRIBUTION.md, LICENSE, NOTICE, LICENSE-*), downloaded from models-<base set> into DIR. Idempotent: creates
# the release only if it is missing (never as Latest), writes its notes (with the SHA-256 list) on every run, uploads
# every file that isn't there with the same name, size and SHA-256 (a same-size replacement too), and at the end
# checks every asset's size and SHA-256 on GitHub against the files here. Run it again after a failure.
# Publishing needs Marcy's OK.
set -euo pipefail
DIR=${1:?usage: tools/upload_model_set.sh DIR SET}
SET=${2:?usage: tools/upload_model_set.sh DIR SET}
TAG="models-$SET"
REPO=MarcelineVPQ/corridorkey-desktop
cd "$DIR"
case "$SET" in
  *-trt)
    # loop: NOT-WORTH — a sorted listing of the set's sixteen files
    mapfile -t FILES < <(ls ck2-*-trt-fp16.onnx ck2-*-trt-fp16.onnx.data ck2-*-trt-fp16-ctx.onnx models.json 2>/dev/null | sort)
    LIST=models.json
    TITLE="Models ${SET%-trt} (TensorRT, fp16)"
    WHAT="CorridorKey 2.0 prepared for TensorRT, for CorridorKey Desktop's optional TensorRT mode (Linux): model set \`$SET\`, fp16, strongly typed (FP32 islands for weight GEMMs and convolutions; docs/ENGINE_RUST.md \"TensorRT\"). The app downloads these when you switch TensorRT on and checks every file's SHA-256 (listed below). You don't need to download them by hand."
    HOW="\`engine-rs/export/build_trt_models.sh\` (docs/ONNX_EXPORT.md, \"TensorRT set\")"
    ;;
  *-coreml)
    # loop: NOT-WORTH — a sorted listing of the set's seven files
    mapfile -t FILES < <(ls ck2-*-fp16-coreml-*.onnx coreml.json 2>/dev/null | sort)
    LIST=coreml.json
    TITLE="Models ${SET%-coreml} (Core ML, fp16)"
    WHAT="CorridorKey 2.0 prepared for Apple's Core ML, for CorridorKey Desktop on Macs with Apple Silicon: model set \`$SET\`, fp16, fixed shapes (1280×1080 and 1920×1080 clips, padded to 1152×1280 and 1152×1920; 4K not yet), every node on ONNX Runtime's Core ML provider (docs/ENGINE_RUST.md, \`--device coreml\`). The files keep their weights in model set \`${SET%-coreml}\`'s \`.onnx.data\` files, so they go into that set's folder. The app's setup downloads these on a Mac and checks every file's SHA-256 (listed below). You don't need to download them by hand."
    HOW="\`engine-rs/export/coreml/build_coreml_models.sh\` (docs/ONNX_EXPORT.md, \"Core ML set\")"
    ;;
  *)
    echo "upload_model_set: SET ends in -trt or -coreml" >&2
    exit 2
    ;;
esac
[ "${#FILES[@]}" -gt 0 ] && [ -f "$LIST" ] || { echo "upload_model_set: no $SET set in $DIR" >&2; exit 1; }
# the licence and attribution files every model release carries (audit 2026-10-27 row 9: the Core ML release went up
# without them): the base set's own copies, downloaded into DIR and uploaded with the set
BASE=${SET%-*}
LICENCE_FILES=(ATTRIBUTION.md LICENSE NOTICE LICENSE-Apache-2.0.txt LICENSE-MIT-MoGe.txt LICENSE-NVIDIA-OPEN-MODEL-2024-06.pdf LICENSE-NVIDIA-OPEN-MODEL-2024-06.txt)
PATTERNS=()
# loop: NOT-WORTH — seven file names
for f in "${LICENCE_FILES[@]}"; do PATTERNS+=(-p "$f"); done
gh release download "models-$BASE" -R "$REPO" -D . --clobber "${PATTERNS[@]}"
FILES+=("${LICENCE_FILES[@]}")
echo "hashing ${#FILES[@]} files in $DIR"
SUMS=$(sha256sum "${FILES[@]}")
# each file as GitHub's asset listing prints it: name, size, sha256 digest
WANT=()
# loop: NOT-WORTH — the set's few files
while read -r hash name; do WANT+=("$name $(stat -c %s "$name") sha256:$hash"); done <<<"$SUMS"

# the notes on every run, so their SHA-256 list is always the files'
NOTES=$(mktemp)
trap 'rm -f "$NOTES"' EXIT
cat >"$NOTES" <<EOF
$WHAT

**CorridorKey** is by Corridor Digital: designed and trained by Zachary Harris with Niko Pueringer and Corridor Digital. Converted from \`corridorkey_v2.safetensors\` (https://huggingface.co/nikopueringer/CorridorKey2.0) with this repository's $HOW. Licensed under the CorridorKey licence (a CC BY-NC-SA 4.0 variant with additional terms; LICENSE in this repository): free to use, never sold.

**Foundation models inside:** C-RADIO by NVIDIA (NVIDIA Open Model License), MoGe by Microsoft (MIT), RVM by Google DeepMind (code Apache 2.0, weights CC-BY 4.0).

**Licence and attribution files:** ATTRIBUTION.md, NOTICE and the LICENSE files here are model set \`$BASE\`'s, unchanged. The per-file rewrites ATTRIBUTION.md lists "in manifest.json" are in that set's manifest.json (https://github.com/$REPO/releases/tag/models-$BASE); this release has none: its own files are listed in \`$LIST\`, and what it changes is above.

SHA-256:
\`\`\`
$SUMS
\`\`\`
EOF
if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  gh release edit "$TAG" -R "$REPO" --notes-file "$NOTES"
else
  gh release create "$TAG" -R "$REPO" --title "$TITLE" --notes-file "$NOTES" --prerelease --latest=false
fi

# GitHub's own record of each asset: name, size and sha256 digest
assets() { gh release view "$TAG" -R "$REPO" --json assets --jq '.assets[] | "\(.name) \(.size) \(.digest)"'; }
HAVE=$(assets)
# loop: SERIAL-REQUIRED — one upload at a time (the line is the limit) [bounded: gh's own timeouts; rerun resumes]
for want in "${WANT[@]}"; do
  f=${want%% *}
  if grep -qxF "$want" <<<"$HAVE"; then
    echo "already there: $f"
    continue
  fi
  echo "uploading $f ($(stat -c %s "$f") bytes)"
  gh release upload "$TAG" -R "$REPO" --clobber "$f"
done

# against the files here, once more
GOT=$(assets)
bad=0
# loop: NOT-WORTH — the set's few files compared
for want in "${WANT[@]}"; do
  grep -qxF "$want" <<<"$GOT" || { echo "MISMATCH on GitHub: ${want%% *} (want: $want)" >&2; bad=1; }
done
[ "$bad" = 0 ] || exit 1
echo "OK: $TAG has all ${#FILES[@]} files, sizes and SHA-256 as here"
echo "$SUMS"
