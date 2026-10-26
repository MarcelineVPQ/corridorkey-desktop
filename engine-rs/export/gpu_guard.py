"""GPU courtesy guard + per-process VRAM sampler for spike runs.

- Refuses to start if Marcy's Sonata is running or another process holds
  > 1 GiB of GPU memory (heavy compute).
- While running, polls every 2 s; if Sonata appears, exits the process
  immediately (exit code 75) so it never competes with her player.
- Stops this process (exit 76) if its own VRAM reaches 12 GiB (Marcy's cap).
- Samples this process's GPU memory (nvidia-smi, every 0.2 s) for peak VRAM,
  measured the same way for PyTorch and ONNX Runtime.
"""
import os
import subprocess
import threading
import time

_peak = 0
_stop = threading.Event()


def sonata_running():
    # loop: SERIAL-REQUIRED — one pgrep [bounded: timeout=10 s]
    r = subprocess.run(["pgrep", "-fai", "mount_sonata|Sonata.AppImage"], capture_output=True, text=True, timeout=10)
    me = {str(os.getpid()), str(os.getppid())}
    # loop: NOT-WORTH — the few pgrep lines
    return [l for l in r.stdout.splitlines()
            if l.split()[0] not in me and "pgrep" not in l and "claude-scratch" not in l]


def gpu_procs():
    # loop: SERIAL-REQUIRED — one nvidia-smi query [bounded: timeout=10 s]
    r = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory",
                        "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10)
    out = {}
    # loop: NOT-WORTH — one line per GPU compute process (a few)
    for l in r.stdout.strip().splitlines():
        # loop: NOT-WORTH — the two fields of a line
        pid, mem = [x.strip() for x in l.split(",")]
        out[int(pid)] = int(mem)
    return out


def check_or_exit():
    s = sonata_running()
    if s:
        print(f"GPU_GUARD refuse: Sonata running: {s[:2]}", flush=True)
        os._exit(75)
    # loop: NOT-WORTH — the few GPU compute processes
    others = {p: m for p, m in gpu_procs().items() if p != os.getpid() and m > 1024}
    if others:
        print(f"GPU_GUARD refuse: other heavy GPU processes {others}", flush=True)
        os._exit(75)


VRAM_CAP_MIB = 12 * 1024  # Marcy's cap for these runs (2026-10-21)


def _loop():
    global _peak
    last = 0.0
    # loop: SERIAL-REQUIRED — the guard's sampler, a poll every 0.2 s (sleep below) until stop() or the process ends
    while not _stop.is_set():
        _peak = max(_peak, gpu_procs().get(os.getpid(), 0))
        if _peak >= VRAM_CAP_MIB:
            print(f"GPU_GUARD abort: own VRAM {_peak} MiB >= cap {VRAM_CAP_MIB} MiB", flush=True)
            os._exit(76)
        if time.time() - last > 2:
            last = time.time()
            if sonata_running():
                print("GPU_GUARD abort: Sonata started during run", flush=True)
                os._exit(75)
            # loop: NOT-WORTH — the few GPU compute processes, every 2 s
            others = {p: m for p, m in gpu_procs().items() if p != os.getpid() and m > 1024}
            if others:  # another agent's GPU job started: yield, never two GPU jobs at once
                print(f"GPU_GUARD abort: other heavy GPU process appeared {others}", flush=True)
                os._exit(75)
        # loop: SERIAL-REQUIRED — the sampler's 0.2 s poll interval (not a spin)
        time.sleep(0.2)


def start():
    check_or_exit()
    # loop: SERIAL-REQUIRED — one daemon sampler thread per run; ends with stop() or the process
    threading.Thread(target=_loop, daemon=True).start()


def peak_mib():
    return _peak


def stop():
    _stop.set()
