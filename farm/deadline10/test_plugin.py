"""The Deadline 10 plugin's command line and task environment, with stand-in Deadline modules (farm senior review
2026-10-26 N8). Run: npm run test:farm."""
import importlib.util
import os
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
        return default

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


def plugin(affinity):
    """The plugin on a worker whose GPU affinity is `affinity` (empty: no override)."""
    p = load_plugin().GetDeadlinePlugin()
    p.env, p.affinity = {}, affinity
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


if __name__ == "__main__":
    unittest.main()
