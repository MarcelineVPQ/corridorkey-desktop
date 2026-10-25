#!/usr/bin/env bash
# Publish a TensorRT model set as this repository's GitHub release `models-<set>` (the app's TensorRT download,
# electron/main/install.ts TENSORRT.models, reads it from there by exact name, size and SHA-256).
#
#   tools/upload_trt_models.sh DIR [SET]     SET defaults to 2.0.0-onnx.4-trt
#
# DIR holds the set as engine-rs/export/build_trt_models.sh writes it: ck2-*-trt-fp16.onnx,
# their .onnx.data, the -ctx.onnx EPContext stubs, and models.json. Idempotent: creates the release only if it is
# missing (never as Latest), uploads only what isn't there with the right size, and at the end checks every asset's
# size and SHA-256 on GitHub against the files here. Run it again after a failure. Publishing needs Marcy's OK.
set -euo pipefail
DIR=${1:?usage: tools/upload_trt_models.sh DIR [SET]}
SET=${2:-2.0.0-onnx.4-trt}
TAG="models-$SET"
REPO=MarcelineVPQ/corridorkey-desktop
cd "$DIR"
# loop: NOT-WORTH — a sorted listing of the set's sixteen files
mapfile -t FILES < <(ls ck2-*-trt-fp16.onnx ck2-*-trt-fp16.onnx.data ck2-*-trt-fp16-ctx.onnx models.json 2>/dev/null | sort)
[ "${#FILES[@]}" -gt 0 ] && [ -f models.json ] || { echo "upload_trt_models: no TensorRT model set in $DIR" >&2; exit 1; }
echo "hashing ${#FILES[@]} files in $DIR"
SUMS=$(sha256sum "${FILES[@]}")

if ! gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  NOTES=$(mktemp)
  trap 'rm -f "$NOTES"' EXIT
  cat >"$NOTES" <<EOF
CorridorKey 2.0 prepared for TensorRT, for CorridorKey Desktop's optional TensorRT mode (Linux): model set \`$SET\`, fp16, strongly typed (FP32 islands for weight GEMMs and convolutions; docs/ENGINE_RUST.md "TensorRT"). The app downloads these when you switch TensorRT on and checks every file's SHA-256 (listed below). You don't need to download them by hand.

**CorridorKey** is by Corridor Digital: designed and trained by Zachary Harris with Niko Pueringer and Corridor Digital. Converted from \`corridorkey_v2.safetensors\` (https://huggingface.co/nikopueringer/CorridorKey2.0) with this repository's \`engine-rs/export/build_trt_models.sh\` (docs/ONNX_EXPORT.md, "TensorRT set"). Licensed under the CorridorKey licence (a CC BY-NC-SA 4.0 variant with additional terms; LICENSE in this repository): free to use, never sold.

**Foundation models inside:** C-RADIO by NVIDIA (NVIDIA Open Model License), MoGe by Microsoft (MIT), RVM by Google DeepMind (code Apache 2.0, weights CC-BY 4.0).

SHA-256:
\`\`\`
$SUMS
\`\`\`
EOF
  gh release create "$TAG" -R "$REPO" --title "Models ${SET%-trt} (TensorRT, fp16)" --notes-file "$NOTES" --latest=false
fi

# loop: NOT-WORTH — one listing of the release's assets
HAVE=$(gh release view "$TAG" -R "$REPO" --json assets --jq '.assets[] | "\(.name) \(.size)"')
# loop: SERIAL-REQUIRED — one upload at a time (the line is the limit) [bounded: gh's own timeouts; rerun resumes]
for f in "${FILES[@]}"; do
  size=$(stat -c %s "$f")
  if grep -qxF "$f $size" <<<"$HAVE"; then
    echo "already there: $f"
    continue
  fi
  echo "uploading $f ($size bytes)"
  gh release upload "$TAG" -R "$REPO" --clobber "$f"
done

# GitHub's own record of each asset: size and sha256 digest, against the files here
# loop: NOT-WORTH — one listing of the release's assets
GOT=$(gh release view "$TAG" -R "$REPO" --json assets --jq '.assets[] | "\(.name) \(.size) \(.digest)"')
bad=0
# loop: NOT-WORTH — sixteen files compared
for f in "${FILES[@]}"; do
  want="$f $(stat -c %s "$f") sha256:$(grep -F "  $f" <<<"$SUMS" | awk -v n="$f" '$2 == n {print $1}')"
  grep -qxF "$want" <<<"$GOT" || { echo "MISMATCH on GitHub: $f (want: $want)" >&2; bad=1; }
done
[ "$bad" = 0 ] || exit 1
echo "OK: $TAG has all ${#FILES[@]} files, sizes and SHA-256 as here"
echo "$SUMS"
