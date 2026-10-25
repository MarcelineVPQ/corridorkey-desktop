"""Collect the built Core ML files into a set folder: coreml.json (what the engine reads for --device coreml) and
SHA256SUMS (what tools/mac_gate.sh checks on the Mac). Each file's external weights must be the shipped set's
ck2-<piece>-fp16.onnx.data, unchanged (checked here), so the files work dropped into the shipped set's folder.

usage: write_set.py BUILD_DIR SET_OUT SHIPPED_SET_DIR
"""
import hashlib
import json
import os
import re
import shutil
import sys

import onnx

build, out, shipped = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
version = json.load(open(os.path.join(shipped, "manifest.json")))["version"]
pat = re.compile(r"^ck2-(\w+)-fp16-coreml-(\d+x\d+)-t(\d+)\.onnx$")
fp16, sums = {}, []
# loop: NOT-WORTH — the build folder's few files
for name in sorted(os.listdir(build)):
    m = pat.match(name)
    if not m:
        continue
    piece, size, t = m.groups()
    model = onnx.load(os.path.join(build, name), load_external_data=False)
    # loop: NOT-WORTH — one pass over the initializers
    locs = {e.value for i in model.graph.initializer for e in i.external_data if e.key == "location"}
    assert locs <= {f"ck2-{piece}-fp16.onnx.data"}, (name, locs)
    shutil.copy2(os.path.join(build, name), os.path.join(out, name))
    fp16.setdefault(size, {})[f"{piece}-t{t}"] = name
    h = hashlib.sha256()
    with open(os.path.join(out, name), "rb") as fh:
        # loop: SERIAL-REQUIRED — 16 MB reads of one file [bounded: the file's size]
        for b in iter(lambda: fh.read(1 << 24), b""):
            h.update(b)
    sums.append(f"{h.hexdigest()}  {name}")
    print(f"{name}: {os.path.getsize(os.path.join(out, name))} bytes, weights in {sorted(locs)}")
json.dump({"format": 1, "source_set": version, "fp16": fp16}, open(os.path.join(out, "coreml.json"), "w"), indent=2)
open(os.path.join(out, "SHA256SUMS"), "w").write("\n".join(sums) + "\n")
print(f"set: {out} ({len(sums)} files, source set {version})")
