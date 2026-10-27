"""The Deadline 10 plugin's argument quoting (farm review 2026-10-26 S6). Run: python3 -I -m unittest discover -s
farm/deadline10 -p 'test_*.py' (npm run test:farm). The plugin imports Deadline's own modules, so its quote() is read
out of CorridorKey.py and run alone."""
import ast
import os
import subprocess
import unittest

PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "CorridorKey", "CorridorKey.py")


def load_quote():
    with open(PLUGIN, encoding="utf-8") as f:
        tree = ast.parse(f.read(), PLUGIN)
    # loop: NOT-WORTH — the plugin's top-level statements, once
    fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "quote")
    scope = {"os": os, "subprocess": subprocess}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), PLUGIN, "exec"), scope)
    return scope["quote"]


def msvc_argv(line):
    """A command line split as Windows programs split it (the MSVC rules, CommandLineToArgvW; Rust's std too)."""
    args, cur, quoted, have, i = [], [], False, False, 0
    # loop: NOT-WORTH — one test line's characters
    while i < len(line):
        c = line[i]
        if c == "\\":
            n = 0
            # loop: NOT-WORTH — a run of backslashes
            while i < len(line) and line[i] == "\\":
                n, i = n + 1, i + 1
            if i < len(line) and line[i] == '"':
                cur.append("\\" * (n // 2))
                if n % 2:
                    cur.append('"')
                    i += 1
            else:
                cur.append("\\" * n)
            have = True
            continue
        if c == '"':
            quoted, have = not quoted, True
        elif c in " \t" and not quoted:
            if have:
                args.append("".join(cur))
            cur, have = [], False
        else:
            cur.append(c)
            have = True
        i += 1
    if have:
        args.append("".join(cur))
    return args


class QuoteTest(unittest.TestCase):
    def test_windows_paths_stay_one_argument(self):
        quote = load_quote()
        paths = ["D:\\shows\\key\\", "D:\\my shows\\key\\", "\\\\farm\\share\\sh010\\", "D:\\plates\\sh010.%04d.exr",
                 'D:\\odd "name"\\', ""]
        # loop: NOT-WORTH — a test's few paths
        for p in paths:
            line = " ".join(["render", "-i", quote(p, True), "-o", quote(p, True), "-s", "1001"])
            self.assertEqual(msvc_argv(line), ["render", "-i", p, "-o", p, "-s", "1001"], line)

    def test_other_systems_keep_double_quotes(self):
        quote = load_quote()
        self.assertEqual(quote("/shows/my key/", False), '"/shows/my key/"')


if __name__ == "__main__":
    unittest.main()
