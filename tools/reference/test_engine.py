"""Protocol tests for ck_engine.serve, with a fake engine (no torch, no GPU).

Run: python3 -I -m unittest discover -s tools/reference -p 'test_*.py'
"""
import io
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ck_engine  # noqa: E402


class FakeEngine:
    def __init__(self):
        self.runs = []

    def pong(self):
        return {"type": "pong", "protocol": ck_engine.PROTOCOL, "version": ck_engine.ENGINE_VERSION}

    def run(self, req):
        self.runs.append(req["id"])
        ck_engine.send({"type": "result", "id": req["id"], "outputs": []})


class ServeTest(unittest.TestCase):
    def setUp(self):
        self.out = io.StringIO()
        self._proto = ck_engine._proto
        ck_engine._proto = self.out

    def tearDown(self):
        ck_engine._proto = self._proto

    def replies(self):
        return [json.loads(line) for line in self.out.getvalue().splitlines()]

    def serve(self, *lines):
        eng = FakeEngine()
        ck_engine.serve(eng, io.StringIO("\n".join(json.dumps(x) if isinstance(x, dict) else x for x in lines) + "\n"))
        return eng

    def test_ping_run_quit(self):
        run = {"cmd": "run", "id": "j1", "input": "/a.mp4", "output_dir": "/o", "temp_dir": "/t"}
        eng = self.serve({"cmd": "ping"}, run, {"cmd": "quit"}, {"cmd": "ping"})
        r = self.replies()
        self.assertEqual(r[0]["type"], "pong")
        self.assertEqual(r[0]["protocol"], 1)
        self.assertEqual(eng.runs, ["j1"])
        self.assertEqual(len(r), 2)  # nothing after quit

    def test_bad_requests_keep_it_running(self):
        eng = self.serve("not json", {"cmd": "run", "id": "j1"}, {"cmd": "fly"}, {"cmd": "ping"})
        r = self.replies()
        self.assertEqual([x.get("code") for x in r[:3]], ["bad-request"] * 3)
        self.assertEqual(r[3]["type"], "pong")
        self.assertEqual(eng.runs, [])

    def test_cancel_a_waiting_job(self):
        run = {"cmd": "run", "id": "j2", "input": "/a.mp4", "output_dir": "/o", "temp_dir": "/t"}
        eng = self.serve({"cmd": "cancel", "id": "j2"}, run)
        self.assertEqual(eng.runs, [])
        self.assertEqual(self.replies()[0]["code"], "cancelled")


class ModelLogTest(unittest.TestCase):
    def test_lines_become_log_replies_and_window_progress(self):
        out = io.StringIO()
        saved, ck_engine._proto = ck_engine._proto, out
        saved_err, sys.stderr = sys.stderr, io.StringIO()
        try:
            log = ck_engine.ModelLog()
            log.job = "j1"
            log.write("      window 2/4 [24:48]\npartial")
            r = [json.loads(x) for x in out.getvalue().splitlines()]
        finally:
            ck_engine._proto, sys.stderr = saved, saved_err
        self.assertEqual(r[0], {"type": "log", "text": "      window 2/4 [24:48]", "id": "j1"})
        self.assertEqual(r[1]["p"], 0.5)
        self.assertEqual(len(r), 2)  # "partial" waits for its newline


if __name__ == "__main__":
    unittest.main()
