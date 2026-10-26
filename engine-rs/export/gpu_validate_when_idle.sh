#!/bin/bash
# Wait until the GPU is quiet (no Sonata, no other process > 1 GiB VRAM for 60 s),
# then run gpu_validate.sh; if its guard stops it (exit 75: someone else needs the
# GPU), wait for quiet again and resume. Gives up after 6 hours.
D=$(cd "$(dirname "$0")" && pwd)
deadline=$(( $(date +%s) + 6*3600 ))
quiet() {
  pgrep -fai 'mount_sonata|Sonata.AppImage' | grep -v -e pgrep -e gpu_validate >/dev/null && return 1
  nvidia-smi --query-compute-apps=used_memory --format=csv,noheader,nounits | awk '$1>1024{f=1} END{exit f}'
}
while [ $(date +%s) -lt $deadline ]; do  # loop: SERIAL-REQUIRED — waits for a quiet GPU, then one validation run [bounded: the 6 h deadline, 10 s polls]
  q=0
  # loop: SERIAL-REQUIRED — six quiet looks, 10 s apart [bounded: the 6 h deadline]
  while [ $q -lt 6 ] && [ $(date +%s) -lt $deadline ]; do
    if quiet; then q=$((q+1)); else q=0; fi
    # loop: SERIAL-REQUIRED — the quiet poll's 10 s interval (not a spin)
    sleep 10
  done
  "$D/gpu_validate.sh" "$@"; rc=$?
  [ $rc -ne 75 ] && exit $rc
  echo "guard stop, waiting for a quiet GPU $(date +%T)"
done
echo "gave up: GPU not quiet within 6 h"; exit 75
