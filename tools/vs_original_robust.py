#!/usr/bin/env python3
"""Robustness cases for the scorecard (BACKLOG row 36, axis 5), run by tools/vs_original.sh: each engine through the
protocol (docs/ENGINE_PROTOCOL.md, the app's way) and the original also through its own CLI (infer.py) where it
can be. Writes OUT/robust.json; tools/vs_original_report.py turns it into the table.

  python3 tools/vs_original_robust.py --out DIR --clip SHORT_CLIP [--big-clip 4K_CLIP]
      [--ours JSON_CMD] [--ours-env K=V ...] [--original JSON_CMD] [--original-env K=V ...]
      [--original-cli JSON_CMD --original-root DIR] [--cases a,b,...] [--queue 20] [--frames 12] [--cpu]

JSON_CMD: the engine's command line as a JSON list (the scorecard passes them). --cpu: no nvidia-smi checks (a
processor-only rehearsal). Outcomes: ok (the expected, clean result), partial (handled, but not cleanly: an error
that doesn't name the cause, a Python traceback for the user), fail (crash, hang, wrong result, left running),
untestable (the way of running has no such thing; the reason is given).

Cases:
  oom            a job with a forced small memory budget (vram_budget_gb 1) on the big clip: expect error `oom`
                 (or a message about memory) and the engine still answering a ping. CLI: untestable (infer.py has
                 no memory-budget option).
  cancel         the running job cancelled the app's way (SIGKILL of the engine's process group after its first
                 frames): everything gone within 5 s, its graphics memory freed; files left behind counted (the app
                 removes the job's staging and temp folders). CLI: Ctrl-C (SIGINT to its process group) after its
                 first window; it must exit within 10 s.
  cancel_queued  a queued job cancelled after its `run` line, while another job runs: expect error `cancelled`
                 for it and no result. (The PyTorch engine reads requests only between jobs: a known gap, BACKLOG
                 row 20; counted as it is.) CLI: untestable (no queue).
  damaged        the short clip cut to 40 % of its bytes: expect error `input`, engine still answering. CLI: a
                 non-zero exit within the deadline (partial when the user gets a Python traceback).
  garbage        2 MB of random bytes named .mov: the same expectations.
  fulldisk       the output folder on a small tmpfs (--full-kb, default 256 KB; mounted in a private user + mount namespace, `unshare -rm`, no
                 root; when the system forbids that: a read-only folder, and the case says so): expect error
                 `output`, engine still answering. CLI: a non-zero exit, no hang.
  queue          N jobs of the short clip (--frames each) in one engine process: all N done, RAM and graphics
                 memory after the last job within 10 % of after the first. CLI: untestable (one input per run; the
                 launcher's folder mode is interactive).
"""
import argparse
import glob
import json
import os
import queue
import random
import re
import shutil
import signal
import subprocess
import sys
import threading
import time

ALL_CASES = ["oom", "cancel", "cancel_queued", "damaged", "garbage", "fulldisk", "queue"]
TITLES = {
    "oom": "Out of memory (forced 1 GB budget, 4K)",
    "cancel": "Cancel the running job",
    "cancel_queued": "Cancel a queued job (after its run line)",
    "damaged": "Damaged input (file cut to 40 %)",
    "garbage": "Not a video (random bytes)",
    "fulldisk": "Output disk full (a small tmpfs)",
    "queue": "Long queue",
}


def tree(root):
    """The process tree under root (from /proc/<pid>/task/<tid>/children)."""
    allp = [root]
    i = 0
    # loop: HOT-PATH-OK — the engine's few processes, a few times per case
    while i < len(allp):
        try:
            # loop: NOT-WORTH — the threads of one process
            for t in os.listdir(f"/proc/{allp[i]}/task"):
                with open(f"/proc/{allp[i]}/task/{t}/children") as fh:
                    allp += [int(x) for x in fh.read().split()]  # loop: NOT-WORTH — a few child pids
        except OSError:
            pass
        i += 1
    return allp


def rss_gb(pids):
    total = 0
    # loop: NOT-WORTH — the engine's few processes
    for p in pids:
        try:
            with open(f"/proc/{p}/status") as fh:
                m = re.search(r"VmRSS:\s+(\d+)", fh.read())
                total += int(m.group(1)) if m else 0
        except OSError:
            pass
    return total / 2**20


def gpu_mb(pids):
    """Graphics memory (MiB) held by these processes, from nvidia-smi; None when it can't be asked."""
    try:
        # loop: NOT-WORTH — one nvidia-smi call per check [bounded: 10 s timeout]
        out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    s = set(pids)
    # loop: NOT-WORTH — a few compute processes
    return sum(int(m) for p, m in (line.split(",") for line in out.splitlines() if line.strip()) if int(p) in s)


def group_alive(pgid):
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def count_files(*dirs):
    n = 0
    # loop: NOT-WORTH — two folders
    for d in dirs:
        # loop: NOT-WORTH — a job's output folder (a few files or one EXR folder)
        for _, _, files in os.walk(d):
            n += len(files)
    return n


class Engine:
    """One engine process speaking the protocol; replies collected by a reader thread."""

    def __init__(self, cmd, env, log_dir, tag, wrap=()):
        os.makedirs(log_dir, exist_ok=True)
        self.err = open(os.path.join(log_dir, f"{tag}.stderr.log"), "w")
        self.replies = open(os.path.join(log_dir, f"{tag}.replies.jsonl"), "w")
        self.p = subprocess.Popen([*wrap, *cmd], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.err,
                                  env={**os.environ, "PYTHONUNBUFFERED": "1", **env}, text=True, bufsize=1,
                                  start_new_session=True)
        self.q = queue.Queue()
        # loop: SERIAL-REQUIRED — the engine's stdout, line by line, until it closes [bounded: the engine's life]
        self.t = threading.Thread(target=self._read, daemon=True)
        self.t.start()

    def _read(self):
        # loop: SERIAL-REQUIRED — reply lines in order [bounded: ends when the engine's stdout closes]
        for line in self.p.stdout:
            self.replies.write(line)
            self.replies.flush()
            try:
                self.q.put(json.loads(line))
            except ValueError:
                pass
        self.q.put(None)

    def send(self, obj):
        try:
            self.p.stdin.write(json.dumps(obj) + "\n")
            self.p.stdin.flush()
            return True
        except (BrokenPipeError, OSError):
            return False

    def wait(self, pred, timeout):
        """The first reply matching pred within timeout s; None on timeout or when the engine's output ends."""
        end = time.monotonic() + timeout
        # loop: SERIAL-REQUIRED — replies in order [bounded: the timeout]
        while True:
            left = end - time.monotonic()
            if left <= 0:
                return None
            try:
                m = self.q.get(timeout=min(left, 1.0))
            except queue.Empty:
                continue
            if m is None:
                return None
            if pred(m):
                return m

    def ping_ok(self, timeout=60):
        return self.send({"cmd": "ping"}) and self.wait(lambda m: m.get("type") == "pong", timeout) is not None  # loop: SERIAL-REQUIRED — one engine reply awaited [bounded: its timeout / --deadline]

    def kill_group(self):
        try:
            os.killpg(self.p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def close(self, timeout=60):
        if self.p.poll() is None:
            self.send({"cmd": "quit"})
            try:
                # loop: SERIAL-REQUIRED — the engine's exit after quit [bounded: timeout, then SIGKILL]
                self.p.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self.kill_group()
                # loop: SERIAL-REQUIRED — reaps the killed engine [bounded: 10 s]
                self.p.wait(timeout=10)
        self.kill_group()  # its ffmpeg children, if any outlived it
        self.err.close()
        self.replies.close()


def job(eid, inp, out, tmp, **opts):
    return {"cmd": "run", "id": eid, "input": inp, "output_dir": out, "temp_dir": tmp, "options": {"outputs": ["alpha", "fg"], **opts}}


def terminal(eid):
    return lambda m: m.get("id") == eid and m.get("type") in ("result", "error")


def err_text(m):
    return f"`{m.get('code')}`: {str(m.get('message', ''))[:160]}"


class Runner:
    def __init__(self, a):
        self.a = a
        self.work = os.path.join(a.out, "work")
        os.makedirs(self.work, exist_ok=True)
        self.userns = self._userns_ok()

    def _userns_ok(self):
        try:
            # loop: NOT-WORTH — one probe [bounded: 10 s timeout]
            return subprocess.run(["unshare", "-rm", "true"], capture_output=True, timeout=10).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False

    def d(self, *parts):
        p = os.path.join(self.work, *parts)
        os.makedirs(p, exist_ok=True)
        return p

    def engine(self, side, tag, wrap=()):
        cmd, env = (self.a.ours, self.a.ours_env) if side == "ours" else (self.a.original, self.a.original_env)
        e = Engine(cmd, env, os.path.join(self.a.out, "logs"), f"{side}-{tag}", wrap)
        if not e.ping_ok(300):
            e.close(5)
            return None
        return e

    # ---- protocol cases

    def oom(self, side):
        clip = self.a.big_clip or self.a.clip
        e = self.engine(side, "oom")
        if not e:
            return {"outcome": "fail", "detail": "the engine didn't start"}
        t0 = time.monotonic()
        e.send(job("oom", clip, self.d(side, "oom", "out"), self.d(side, "oom", "tmp"), vram_budget_gb=1.0, num_frames=8))
        m = e.wait(terminal("oom"), self.a.deadline)  # loop: SERIAL-REQUIRED — one engine reply awaited [bounded: its timeout / --deadline]
        dt = time.monotonic() - t0
        alive = e.ping_ok(60) if m else False
        e.close()
        if m is None:
            return {"outcome": "fail", "detail": f"no reply within {self.a.deadline} s (hang or crash, exit {e.p.returncode})"}
        if m["type"] == "result":
            return {"outcome": "ok", "detail": f"finished inside 1 GB ({dt:.0f} s)"}
        named = m.get("code") == "oom" or "memory" in str(m.get("message", "")).lower()
        return {"outcome": ("ok" if named else "partial") if alive else "fail",
                "detail": f"error {err_text(m)} after {dt:.0f} s; engine {'still answering' if alive else 'gone'}"}

    def cancel(self, side):
        e = self.engine(side, "cancel")
        if not e:
            return {"outcome": "fail", "detail": "the engine didn't start"}
        out, tmp = self.d(side, "cancel", "out"), self.d(side, "cancel", "tmp")
        e.send(job("c1", self.a.clip, out, tmp))
        m = e.wait(lambda m: m.get("id") == "c1" and ((m.get("type") == "frames" and m.get("done", 0) > 0) or m.get("type") in ("result", "error")), self.a.deadline)  # loop: SERIAL-REQUIRED — one engine reply awaited [bounded: its timeout / --deadline]
        if not m or m.get("type") != "frames":
            e.close(5)
            return {"outcome": "fail", "detail": f"the job never got to its first frames ({m and err_text(m)})"}
        pids = tree(e.p.pid)
        t0 = time.monotonic()
        e.kill_group()
        try:
            # loop: SERIAL-REQUIRED — the killed engine's exit [bounded: 10 s]
            e.p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        end = t0 + 5
        # loop: SERIAL-REQUIRED — waits for the process group to empty [bounded: 5 s]
        while group_alive(e.p.pid) and time.monotonic() < end:
            time.sleep(0.1)  # loop: SERIAL-REQUIRED — the poll's pause [bounded: its loop's deadline]
        gone = not group_alive(e.p.pid)
        dt = time.monotonic() - t0
        freed = None
        if not self.a.cpu:
            end = time.monotonic() + 10
            # loop: SERIAL-REQUIRED — polls nvidia-smi until the killed processes hold no graphics memory [bounded: 10 s]
            while (freed := gpu_mb(pids)) and time.monotonic() < end:
                time.sleep(0.5)  # loop: SERIAL-REQUIRED — the poll's pause [bounded: its loop's deadline]
        left = count_files(out, tmp)
        e.close(1)
        ok = gone and dt <= 5 and (self.a.cpu or freed == 0)
        mem = "" if self.a.cpu else (", graphics memory freed" if freed == 0 else f", {freed} MiB still held after 10 s")
        return {"outcome": "ok" if ok else "fail",
                "detail": f"{'all processes gone' if gone else 'processes LEFT RUNNING'} in {dt:.1f} s{mem}; {left} files left in its output/temp folders (the app removes them)"}

    def cancel_queued(self, side):
        e = self.engine(side, "cancelq")
        if not e:
            return {"outcome": "fail", "detail": "the engine didn't start"}
        e.send(job("qa", self.a.clip, self.d(side, "cq", "a"), self.d(side, "cq", "ta"), num_frames=self.a.frames))
        started = e.wait(lambda m: m.get("id") == "qa" and m.get("type") in ("progress", "frames", "error", "result"), self.a.deadline)  # loop: SERIAL-REQUIRED — one engine reply awaited [bounded: its timeout / --deadline]
        e.send(job("qb", self.a.clip, self.d(side, "cq", "b"), self.d(side, "cq", "tb"), num_frames=self.a.frames))
        e.send({"cmd": "cancel", "id": "qb"})
        m = e.wait(terminal("qb"), self.a.deadline)  # loop: SERIAL-REQUIRED — one engine reply awaited [bounded: its timeout / --deadline]
        e.close()
        if not started:
            return {"outcome": "fail", "detail": "the first job never started"}
        if m is None:
            return {"outcome": "fail", "detail": "no reply for the cancelled job"}
        if m["type"] == "error" and m.get("code") == "cancelled":
            return {"outcome": "ok", "detail": "error `cancelled`, the job never ran"}
        return {"outcome": "fail", "detail": f"the cancelled job ran anyway ({m['type']}{': ' + err_text(m) if m['type'] == 'error' else ''})"}

    def _bad_input(self, side, path, tag):
        e = self.engine(side, tag)
        if not e:
            return {"outcome": "fail", "detail": "the engine didn't start"}
        t0 = time.monotonic()
        e.send(job(tag, path, self.d(side, tag, "out"), self.d(side, tag, "tmp")))
        m = e.wait(terminal(tag), self.a.deadline)  # loop: SERIAL-REQUIRED — one engine reply awaited [bounded: its timeout / --deadline]
        dt = time.monotonic() - t0
        alive = e.ping_ok(60) if m else False
        e.close()
        if m is None:
            return {"outcome": "fail", "detail": f"no reply within {self.a.deadline} s (exit {e.p.returncode})"}
        if m["type"] == "result":
            return {"outcome": "partial", "detail": f"finished ({dt:.0f} s): it keyed what it could decode, without saying the file is damaged"}
        if not alive:
            return {"outcome": "fail", "detail": f"error {err_text(m)}, then the engine was gone"}
        return {"outcome": "ok" if m.get("code") == "input" else "partial", "detail": f"error {err_text(m)} after {dt:.1f} s; engine still answering"}

    def damaged(self, side):
        return self._bad_input(side, self.damaged_file(), "damaged")

    def garbage(self, side):
        return self._bad_input(side, self.garbage_file(), "garbage")

    def damaged_file(self):
        p = os.path.join(self.d("inputs"), "damaged" + os.path.splitext(self.a.clip)[1])
        if not os.path.exists(p):
            size = os.path.getsize(self.a.clip)
            with open(self.a.clip, "rb") as src, open(p, "wb") as dst:
                dst.write(src.read(int(size * 0.4)))
        return p

    def garbage_file(self):
        p = os.path.join(self.d("inputs"), "garbage.mov")
        if not os.path.exists(p):
            with open(p, "wb") as fh:
                fh.write(random.Random(36).randbytes(2 * 2**20))
        return p

    def full_target(self, side, tag):
        """(wrap, output folder, method): a --full-kb tmpfs in a private namespace, or a read-only folder."""
        mnt = self.d(side, tag, "mnt")
        if self.userns:
            kb = self.a.full_kb
            wrap = ("unshare", "-rm", "sh", "-c", f'mount -t tmpfs -o size={kb}k tmpfs "$0" && exec "$@"', mnt)
            return wrap, os.path.join(mnt, "out"), f"{kb} KB tmpfs (private namespace)"
        os.chmod(mnt, 0o555)
        return (), os.path.join(mnt, "out"), "read-only folder (user namespaces are not allowed here)"

    def fulldisk(self, side):
        wrap, out, method = self.full_target(side, "full")
        cmd, env = (self.a.ours, self.a.ours_env) if side == "ours" else (self.a.original, self.a.original_env)
        e = Engine(cmd, env, os.path.join(self.a.out, "logs"), f"{side}-fulldisk", wrap)
        if not e.ping_ok(300):
            e.close(5)
            return {"outcome": "fail", "detail": f"the engine didn't start ({method})"}
        t0 = time.monotonic()
        e.send(job("full", self.a.clip, out, self.d(side, "full", "tmp")))
        m = e.wait(terminal("full"), self.a.deadline)  # loop: SERIAL-REQUIRED — one engine reply awaited [bounded: its timeout / --deadline]
        dt = time.monotonic() - t0
        alive = e.ping_ok(60) if m else False
        e.close()
        if m is None:
            return {"outcome": "fail", "detail": f"{method}: no reply within {self.a.deadline} s"}
        if m["type"] == "result":
            return {"outcome": "fail", "detail": f"{method}: reported success with a full disk (if its outputs fit in {self.a.full_kb} KB, lower --full-kb)"}
        if not alive:
            return {"outcome": "fail", "detail": f"{method}: error {err_text(m)}, then the engine was gone"}
        return {"outcome": "ok" if m.get("code") == "output" else "partial", "detail": f"{method}: error {err_text(m)} after {dt:.1f} s; engine still answering"}

    def queue(self, side):
        e = self.engine(side, "queue")
        if not e:
            return {"outcome": "fail", "detail": "the engine didn't start"}
        n, done, errors, rss, vram, times = self.a.queue, 0, [], [], [], []
        # loop: SERIAL-REQUIRED — the queue's jobs, one at a time like the app [bounded: --queue jobs, each with the deadline]
        for i in range(n):
            out, tmp = self.d(side, "queue", f"o{i}"), self.d(side, "queue", f"t{i}")
            t0 = time.monotonic()
            e.send(job(f"j{i}", self.a.clip, out, tmp, num_frames=self.a.frames))
            m = e.wait(terminal(f"j{i}"), self.a.deadline)  # loop: SERIAL-REQUIRED — one engine reply awaited [bounded: its timeout / --deadline]
            times.append(time.monotonic() - t0)
            if m is None:
                errors.append(f"job {i + 1}: no reply")
                break
            if m["type"] == "error":
                errors.append(f"job {i + 1}: {err_text(m)}")
            else:
                done += 1
            pids = tree(e.p.pid)
            rss.append(rss_gb(pids))
            vram.append(None if self.a.cpu else gpu_mb(pids))
            shutil.rmtree(out, ignore_errors=True)
        alive = e.ping_ok(60)
        e.close()
        grow = (rss[-1] - rss[0]) / rss[0] if len(rss) > 1 and rss[0] else 0.0
        vgrow = (vram[-1] - vram[0]) / vram[0] if len(vram) > 1 and vram[0] else 0.0
        ok = done == n and alive and grow <= 0.10 and vgrow <= 0.10
        vtxt = "" if self.a.cpu or not vram or vram[0] is None else f"; graphics memory {vram[0] / 1024:.2f} → {vram[-1] / 1024:.2f} GiB"
        mid = sorted(times)[len(times) // 2] if times else 0
        return {"outcome": "ok" if ok else "fail",
                "detail": f"{done}/{n} done ({self.a.frames} frames each, median {mid:.1f} s per job); RAM {rss[0] if rss else 0:.2f} → {rss[-1] if rss else 0:.2f} GiB{vtxt}"
                + (f"; {errors[0]}" if errors else "") + ("" if alive else "; engine gone at the end"),
                "rss_gb": rss, "vram_mb": vram, "times_s": times}

    # ---- the original's CLI

    def cli(self, tag, inp, out, wrap=(), sigint_after_window=False):
        cmd = [*wrap, *self.a.original_cli, "--input", inp, "--output_dir", out, "--temp_dir", self.d("cli", tag, "tmp"),
               "--outputs", "alpha", "fg"]
        log = open(os.path.join(self.a.out, "logs", f"original_cli-{tag}.log"), "w")
        p = subprocess.Popen(cmd, cwd=self.a.original_root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                             bufsize=1, start_new_session=True, env={**os.environ, "PYTHONUNBUFFERED": "1", **self.a.original_env})
        lines, saw_window = [], threading.Event()

        def read():
            # loop: SERIAL-REQUIRED — the CLI's output, line by line [bounded: the process's life]
            for line in p.stdout:
                log.write(line)
                lines.append(line.rstrip())
                if re.search(r"window \d+/\d+", line):
                    saw_window.set()

        # loop: SERIAL-REQUIRED — the CLI's output reader [bounded: ends with the process]
        t = threading.Thread(target=read, daemon=True)
        t.start()
        t0 = time.monotonic()
        stopped_at = None
        if sigint_after_window:
            if saw_window.wait(self.a.deadline):  # loop: SERIAL-REQUIRED — waits for the CLI's first window [bounded: --deadline]
                stopped_at = time.monotonic()
                os.killpg(p.pid, signal.SIGINT)
        try:
            # loop: SERIAL-REQUIRED — the CLI run [bounded: 10 s after Ctrl-C, else the deadline]
            rc = p.wait(timeout=10 if stopped_at else self.a.deadline)
        except subprocess.TimeoutExpired:
            rc = None
        dt = time.monotonic() - (stopped_at or t0)
        if rc is None:
            os.killpg(p.pid, signal.SIGKILL)
            # loop: SERIAL-REQUIRED — reaps the killed CLI [bounded: 10 s]
            p.wait(timeout=10)
        # loop: SERIAL-REQUIRED — the reader's last lines [bounded: 5 s]
        t.join(5)
        log.close()
        traceback = any(x.startswith("Traceback (most recent call last)") for x in lines)  # loop: NOT-WORTH — its output lines
        return rc, dt, lines, traceback, stopped_at is not None

    def cli_bad(self, tag, inp, wrap=(), out=None, what=""):
        rc, dt, lines, tb, _ = self.cli(tag, inp, out or self.d("cli", tag, "out"), wrap)
        last = next((x for x in reversed(lines) if x.strip()), "")[:160]  # loop: NOT-WORTH — its output lines
        if rc is None:
            return {"outcome": "fail", "detail": f"{what}no exit within {self.a.deadline} s (killed)"}
        if rc == 0:
            return {"outcome": "fail", "detail": f"{what}exit 0 (reported success); last line: {last}"}
        return {"outcome": "partial" if tb else "ok", "detail": f"{what}exit {rc} after {dt:.1f} s, {'a Python traceback' if tb else 'a message'}; last line: {last}"}

    def cli_case(self, case):
        u = lambda why: {"outcome": "untestable", "detail": why}  # noqa: E731
        if case == "oom":
            return u("infer.py has no memory-budget option")
        if case == "cancel_queued":
            return u("the CLI has no queue")
        if case == "queue":
            return u("infer.py keys one input per run (each run loads the model again); the launcher's folder mode is interactive")
        if case == "damaged":
            return self.cli_bad("damaged", self.damaged_file())
        if case == "garbage":
            return self.cli_bad("garbage", self.garbage_file())
        if case == "fulldisk":
            wrap, out, method = self.full_target("cli", "full")
            return self.cli_bad("fulldisk", self.a.clip, wrap, out, f"{method}: ")
        if case == "cancel":
            out = self.d("cli", "cancel", "out")
            rc, dt, lines, tb, stopped = self.cli("cancel", self.a.clip, out, sigint_after_window=True)
            if not stopped:
                return {"outcome": "fail", "detail": f"never reached its first window (exit {rc})"}
            left = count_files(out, self.d("cli", "cancel", "tmp"))
            if rc is None:
                return {"outcome": "fail", "detail": f"still running 10 s after Ctrl-C (killed); {left} files left"}
            return {"outcome": "ok", "detail": f"exit {rc} {dt:.1f} s after Ctrl-C{' (with a traceback)' if tb else ''}; {left} files left in its output/temp folders"}
        return u("unknown case")


def parse_env(items):
    out = {}
    # loop: NOT-WORTH — a few K=V pairs
    for kv in items or []:
        k, _, v = kv.partition("=")
        out[k] = v
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--clip", required=True, help="a short clip (an HD video)")
    ap.add_argument("--big-clip", help="the out-of-memory case's clip (a 4K plate)")
    ap.add_argument("--ours", type=json.loads)
    ap.add_argument("--ours-env", action="append")
    ap.add_argument("--original", type=json.loads)
    ap.add_argument("--original-env", action="append")
    ap.add_argument("--original-cli", type=json.loads)
    ap.add_argument("--original-root")
    ap.add_argument("--cases", default=",".join(ALL_CASES))
    ap.add_argument("--queue", type=int, default=20)
    ap.add_argument("--frames", type=int, default=12)
    ap.add_argument("--deadline", type=int, default=900, help="seconds a case may take before it counts as a hang")
    ap.add_argument("--cpu", action="store_true", help="no nvidia-smi checks (processor-only rehearsal)")
    ap.add_argument("--full-kb", type=int, default=256, help="the full-disk case's tmpfs size (smaller than the job's outputs)")
    a = ap.parse_args()
    a.ours_env, a.original_env = parse_env(a.ours_env), parse_env(a.original_env)
    os.makedirs(os.path.join(a.out, "logs"), exist_ok=True)
    r = Runner(a)
    res = {"cases": [], "method": {"userns_tmpfs": r.userns, "queue": a.queue, "frames": a.frames, "deadline_s": a.deadline,
                                   "clip": a.clip, "big_clip": a.big_clip, "cpu": a.cpu}}
    path = os.path.join(a.out, "robust.json")
    # loop: SERIAL-REQUIRED — one case at a time (one GPU) [bounded: the cases asked for, each with the deadline]
    for case in [c for c in a.cases.split(",") if c]:  # loop: NOT-WORTH — the case names
        if case not in ALL_CASES:
            raise SystemExit(f"unknown case {case} ({', '.join(ALL_CASES)})")
        row = {"case": case, "title": TITLES[case]}
        # loop: SERIAL-REQUIRED — the engines one after the other
        for side in ("ours", "original"):
            if (a.ours if side == "ours" else a.original):
                print(f"== {case}: {side}", flush=True)
                row[side] = getattr(r, case)(side)
                print(f"   {row[side]['outcome']}: {row[side]['detail']}", flush=True)
        if a.original_cli:
            print(f"== {case}: original CLI", flush=True)
            row["original_cli"] = r.cli_case(case)
            print(f"   {row['original_cli']['outcome']}: {row['original_cli']['detail']}", flush=True)
        res["cases"].append(row)
        with open(path, "w") as fh:
            json.dump(res, fh, indent=2)
    # the inputs and outputs made here are scratch: only the logs and robust.json stay
    # loop: NOT-WORTH — the work folder's read-only mount points, made writable again before removal
    for d in glob.glob(os.path.join(r.work, "*", "*", "mnt")):
        os.chmod(d, 0o755)
    shutil.rmtree(r.work, ignore_errors=True)
    print(f"robust: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
