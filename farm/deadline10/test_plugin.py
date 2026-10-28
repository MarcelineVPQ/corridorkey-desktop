"""The Deadline 10 plugin's command line and task environment, with stand-in Deadline modules (farm senior review
2026-10-26 N8). Run: npm run test:farm."""
import importlib.util
import os
import re
import sys
import types
import unittest

PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "CorridorKey", "CorridorKey.py")


class Event:
    def __iadd__(self, fn):
        return self


class StandInPlugin:
    """The DeadlinePlugin members the plugin uses (its __init__ doesn't call this class's); a job of two frames."""

    InitializeProcessCallback = RenderExecutableCallback = RenderArgumentCallback = CheckExitCodeCallback = Event()

    def GetPluginInfoEntryWithDefault(self, key, default):
        return default

    def GetPluginInfoEntry(self, key):
        return {"InputPath": "/plates/", "OutputPath": "/key/"}[key]

    def GetIntegerPluginInfoEntryWithDefault(self, key, default):
        return self.ints.get(key, default)

    def GetConfigEntryWithDefault(self, key, default):
        return default

    def GetStartFrame(self):
        return 1001

    def GetEndFrame(self):
        return 1002

    def OverrideGpuAffinity(self):
        return bool(self.affinity)

    def GpuAffinity(self):
        return self.affinity

    def GetThreadNumber(self):
        return 1

    def LogInfo(self, text):
        pass

    def FailRender(self, text):
        raise AssertionError(text)

    def SetProcessEnvironmentVariable(self, key, value):
        self.env[key] = value


def plugin(affinity, ints=None):
    """The plugin on a worker whose GPU affinity is `affinity` (empty: no override); `ints`: integer job options."""
    p = load_plugin().GetDeadlinePlugin()
    p.env, p.affinity, p.ints = {}, affinity, ints or {}
    return p


def load_plugin():
    deadline = types.ModuleType("Deadline")
    plugins = types.ModuleType("Deadline.Plugins")
    plugins.DeadlinePlugin, plugins.PluginType = StandInPlugin, types.SimpleNamespace(Simple=0)
    scripting = types.ModuleType("Deadline.Scripting")
    scripting.FileUtils = types.SimpleNamespace(SearchFileList=lambda s: s)
    scripting.RepositoryUtils = types.SimpleNamespace(CheckPathMapping=lambda p: p)
    sys.modules.update({"Deadline": deadline, "Deadline.Plugins": plugins, "Deadline.Scripting": scripting})
    spec = importlib.util.spec_from_file_location("CorridorKey", PLUGIN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class GpuOrderTest(unittest.TestCase):
    def test_a_gpu_pick_counts_in_pci_order(self):
        p = plugin([0, 1])
        self.assertIn("--gpu 1", p.RenderArgument())
        self.assertEqual(p.env, {"CUDA_DEVICE_ORDER": "PCI_BUS_ID"})

    def test_no_gpu_pick_leaves_the_environment(self):
        p = plugin([])
        self.assertNotIn("--gpu", p.RenderArgument())
        self.assertEqual(p.env, {})


class WarmUpTest(unittest.TestCase):
    """Chunked jobs get both warm-up options, as the other submitters (whole-code review 2026-10-27: no Tail)."""

    def test_preroll_and_tail_reach_the_command_line(self):
        args = plugin([], {"Preroll": 2, "Tail": 3}).RenderArgument()
        self.assertIn("--preroll 2", args)
        self.assertIn("--tail 3", args)

    def test_none_by_default(self):
        args = plugin([]).RenderArgument()
        self.assertNotIn("--preroll", args)
        self.assertNotIn("--tail", args)


class DefaultExecutableTest(unittest.TestCase):
    """The plugin's default executable paths are where each system's package puts corridorkey (whole-code review
    2026-10-27: all three named a "CorridorKey Desktop" folder or app the packages don't make)."""

    def test_the_defaults_are_the_packages_paths(self):
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "..", "..", "electron-builder.yml"), encoding="utf-8") as f:
            product = re.search(r"^productName: (.+)$", f.read(), re.M).group(1).strip()
        with open(os.path.join(here, "..", "README.md"), encoding="utf-8") as f:
            readme = f.read()
        with open(os.path.join(here, "CorridorKey", "CorridorKey.param"), encoding="utf-8") as f:
            param = f.read()
        section = param[param.index("[CorridorKey_Executable]"):]
        defaults = re.search(r"^Default=(.*)$", section, re.M).group(1).split(";")
        # the NSIS installer's all-users folder is the product name; the macOS app is <product>.app
        self.assertEqual(defaults[0], "C:\\Program Files\\%s\\resources\\engine\\corridorkey.exe" % product)
        # the Linux path is the one farm/README.md tells a worker to extract the AppImage to
        self.assertIn(defaults[1], readme)
        self.assertTrue(defaults[1].endswith("/squashfs-root/resources/engine/corridorkey"))
        self.assertEqual(defaults[2], "/Applications/%s.app/Contents/Resources/engine/corridorkey" % product)


if __name__ == "__main__":
    unittest.main()
