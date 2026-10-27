#!/usr/bin/env python3
"""Submit a CorridorKey shot to OpenCue (PyOutline): a `render` layer on one GPU, then a `verify` layer after it.

    python3 corridorkey_submit.py --show demo --shot sh010 \\
        -i /shows/demo/sh010/plates/sh010.####.exr -o /shows/demo/sh010/key/sh010_key.####.exr \\
        --range 1001-1100 -- --linear --outputs alpha

One task per shot by default (chunk = the shot's length): that is the app's matte, bit for bit. `--chunk N` splits it;
chunks are near-identical with `--preroll` warm-up frames, how many is not measured yet (docs/CLI.md, "Warm-up").

The commands go to Cuebot as they are (`use_pycuerun=False`); Cuebot fills in #FRAME_START# / #FRAME_END# per task
(corridorkey's -s / -e). RQD exports the booked card as CUE_GPU_CORES, which corridorkey reads when no --gpu is
given. GPU booking needs RQD's GPU support on the hosts and an outline spec_version of 1.12 or later (PyOutline drops
`gpus` / `gpu_memory` with a warning below that). Not yet run on a real OpenCue (farm/README.md).
"""
import argparse
import getpass
import shlex

import outline
import outline.cuerun
import outline.modules.shell

# Graphics memory booked per task, GiB. Measured peaks (README.md, "The same-day pair on onnx.4 (2026-10-26)" and
# "What we got wrong" 5, RTX 5080, onnx.4): CUDA 9.07 (1280x1080) and 9.29 (4096x2160); TensorRT 11.04 and 10.79;
# 3200x1800 at the 8/4 window 11.79. The task also gets --max-vram of the same size, so the engine picks a window
# whose (upper-bound) estimate fits the booking.
DEFAULT_GPU_MEMORY_GB = 12
# RAM booked per task, GiB: the engine's measured peak was 13.55 at 4K and 6.49 at 1280x1080 (the same tables).
DEFAULT_MEMORY_GB = 16


def shell_line(args):
    """One command line for the host's shell (PyOutline joins a list with plain spaces, which splits a path with a
    space in it): every argument quoted except Cuebot's #TOKENS#, which it replaces in the text before RQD runs it."""
    # loop: NOT-WORTH — a few dozen arguments, once per submission
    return " ".join(x if x.startswith("#") and x.endswith("#") else shlex.quote(x) for x in args)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("-i", "--input", required=True, help="the clip: a movie, a frame folder or plate.####.exr")
    ap.add_argument("-o", "--output", required=True, help="a folder or a frame pattern (key.####.exr)")
    ap.add_argument("--range", required=True, help="the shot's frames, FIRST-LAST (a movie's first frame is 1001)")
    ap.add_argument("--chunk", type=int, default=0, help="frames per task (default: the whole shot in one task)")
    ap.add_argument("--preroll", type=int, default=0, help="warm-up frames before each chunk (chunks only)")
    ap.add_argument("--gpu-memory", type=int, default=DEFAULT_GPU_MEMORY_GB, help="GiB of graphics memory per task (12)")
    ap.add_argument("--max-vram", type=float, help="limit the engine's graphics memory, GB (default: what the card has free)")
    ap.add_argument("--memory", type=int, default=DEFAULT_MEMORY_GB, help="GiB of RAM per task (16)")
    ap.add_argument("--corridorkey", default="corridorkey", help="the corridorkey executable on the hosts")
    ap.add_argument("--models", help="the model set's folder on the hosts (else their CK_ENGINE_MODELS)")
    ap.add_argument("--ort", help="ONNX Runtime's library on the hosts (else their CK_ENGINE_ORT / ORT_DYLIB_PATH)")
    ap.add_argument("--service", help="the OpenCue service for both layers (default: the site's default)")
    ap.add_argument("--show", required=True)
    ap.add_argument("--shot", required=True)
    ap.add_argument("--name", help="the job's name (default: <shot>_corridorkey)")
    ap.add_argument("extra", nargs="*", help="after --: more corridorkey flags for both commands (docs/CLI.md)")
    a = ap.parse_args()

    # loop: NOT-WORTH — the two ends of one range string, once per submission
    first, last = (int(x) for x in a.range.split("-"))
    if last < first:
        ap.error("--range: LAST is before FIRST")
    shot_len = last - first + 1
    chunk = a.chunk or shot_len

    common = ["-i", a.input, "-o", a.output]
    if a.models:
        common += ["--models", a.models]
    if a.ort:
        common += ["--ort", a.ort]
    common += a.extra

    ol = outline.Outline(a.name or "%s_corridorkey" % a.shot, shot=a.shot, show=a.show, user=getpass.getuser())

    render_cmd = [a.corridorkey, "render"] + common + [
        "-s", "#FRAME_START#", "-e", "#FRAME_END#",
        # a retried task finds the frames its earlier try renamed into place: replace them
        "--overwrite",
        "--progress-format", "plain",
    ]
    if a.max_vram:
        render_cmd += ["--max-vram", "%g" % a.max_vram]
    if a.preroll:
        render_cmd += ["--preroll", str(a.preroll)]
    render = outline.modules.shell.Shell(
        "render", command=shell_line(render_cmd), range=a.range, chunk=chunk,
        gpus=1, gpu_memory="%dg" % a.gpu_memory, memory="%dg" % a.memory,
    )

    # one task over the whole shot, after every render task: is every frame there and a whole EXR? (exit 9 if not)
    verify_cmd = [a.corridorkey, "verify"] + common + ["-F", "%d-%d" % (first, last), "--progress-format", "plain"]
    verify = outline.modules.shell.Shell("verify", command=shell_line(verify_cmd), range=str(first), chunk=1)

    if a.service:
        render.set_service(a.service)
        verify.set_service(a.service)
    ol.add_layer(render)
    ol.add_layer(verify)
    verify.depend_all(render)
    outline.cuerun.launch(ol, use_pycuerun=False)


if __name__ == "__main__":
    main()
