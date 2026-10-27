"""CorridorKey: a Thinkbox Deadline 10 application plugin for the `corridorkey` command line (docs/CLI.md).

One task keys the frames GetStartFrame()..GetEndFrame() with `corridorkey render -s START -e END`. Submit with
ChunkSize = the shot's length (one task per shot): that is the app's matte, bit for bit. Smaller chunks are
near-identical with --preroll warm-up frames; how many make seams invisible is not measured yet (docs/CLI.md,
"Warm-up").

Progress comes from the CLI's `--progress-format deadline` lines on stdout: `PROGRESS: 45%`, `STATUS: ...` and,
before a non-zero exit, `ERROR: ... (exit N, reason)`. The ERROR line is kept and the task is failed from the exit
code check, after the CLI has exited: failing inside the stdout handler would stop the process before it removes its
hidden work folders.

Written against the Deadline 10 scripting reference (DeadlinePlugin, StdoutHandling, AddStdoutHandlerCallback,
CheckExitCodeCallback, GpuAffinity, OverrideGpuAffinity). Not yet run on a real Deadline (farm/README.md).
"""
import os

from Deadline.Plugins import DeadlinePlugin, PluginType
from Deadline.Scripting import FileUtils, RepositoryUtils


def GetDeadlinePlugin():
    return CorridorKeyPlugin()


def CleanupDeadlinePlugin(deadlinePlugin):
    deadlinePlugin.Cleanup()


# docs/CLI.md "Exit codes": what a code means, for the task's error report
EXIT_MEANINGS = {
    2: "usage: a bad flag, value, frame list or job file (a retry won't help: fix the job)",
    3: "input: the clip or a hint can't be read (a retry won't help)",
    4: "output: not writable, disk full, or frames already there",
    5: "no usable graphics card on this worker",
    6: "out of graphics memory (try MaxVram lower, --low-vram, or a bigger card)",
    7: "models, ONNX Runtime, ffmpeg or a library missing (run `corridorkey prepare` on this worker)",
    8: "the engine failed (a bug: the message and the report say what)",
    9: "verify: a requested frame is missing or not a whole EXR",
    130: "stopped by SIGINT",
    143: "stopped by SIGTERM",
}


def quote(s):
    return '"%s"' % s


class CorridorKeyPlugin(DeadlinePlugin):
    def __init__(self):
        self.InitializeProcessCallback += self.InitializeProcess
        self.RenderExecutableCallback += self.RenderExecutable
        self.RenderArgumentCallback += self.RenderArgument
        self.CheckExitCodeCallback += self.CheckExitCode
        self.errorLine = None

    def Cleanup(self):
        # loop: NOT-WORTH — three handlers, once per task
        for stdoutHandler in self.StdoutHandlers:
            del stdoutHandler.HandleCallback
        del self.InitializeProcessCallback
        del self.RenderExecutableCallback
        del self.RenderArgumentCallback
        del self.CheckExitCodeCallback

    def InitializeProcess(self):
        self.PluginType = PluginType.Simple
        self.SingleFramesOnly = False
        self.StdoutHandling = True
        self.UseProcessTree = True
        self.AddStdoutHandlerCallback(r"^PROGRESS: (\d+)%").HandleCallback += self.HandleProgress
        self.AddStdoutHandlerCallback(r"^STATUS: (.*)").HandleCallback += self.HandleStatus
        self.AddStdoutHandlerCallback(r"^ERROR: (.*)").HandleCallback += self.HandleError

    def RenderExecutable(self):
        exeList = self.GetConfigEntry("CorridorKey_Executable")
        exe = FileUtils.SearchFileList(exeList)
        if exe == "":
            self.FailRender(
                'corridorkey was not found in "%s". Set its path in Configure Plugins > CorridorKey.' % exeList
            )
        return exe

    def firstExisting(self, key, isDir):
        """The first path of a config entry's ';'-separated list that exists here, path-mapped; '' if none is set."""
        # loop: NOT-WORTH — a few configured paths, once per task
        paths = [p.strip() for p in self.GetConfigEntryWithDefault(key, "").split(";") if p.strip()]
        # loop: NOT-WORTH — a few configured paths, once per task
        for p in paths:
            p = RepositoryUtils.CheckPathMapping(p)
            if (os.path.isdir(p) if isDir else os.path.isfile(p)):
                return p
        if paths:
            self.FailRender('None of the paths in the CorridorKey plugin setting %s exist on this worker: %s' % (key, ";".join(paths)))
        return ""

    def RenderArgument(self):
        command = self.GetPluginInfoEntryWithDefault("Command", "render")
        if command not in ("render", "verify"):
            self.FailRender("Command must be render or verify, got %s" % command)
        inputPath = RepositoryUtils.CheckPathMapping(self.GetPluginInfoEntry("InputPath"))
        outputPath = RepositoryUtils.CheckPathMapping(self.GetPluginInfoEntry("OutputPath"))

        args = [
            command,
            "-i", quote(inputPath),
            "-o", quote(outputPath),
            "-s", str(self.GetStartFrame()),
            "-e", str(self.GetEndFrame()),
            "--progress-format", "deadline",
            # a retried task finds the frames its earlier try renamed into place: replace them
            "--overwrite",
        ]

        outputs = self.GetPluginInfoEntryWithDefault("Outputs", "").strip()
        if outputs:
            args += ["--outputs", outputs]
        preroll = self.GetIntegerPluginInfoEntryWithDefault("Preroll", 0)
        if preroll > 0:
            args += ["--preroll", str(preroll)]
        maxVram = self.GetPluginInfoEntryWithDefault("MaxVram", "").strip()
        if maxVram:
            args += ["--max-vram", maxVram]

        models = self.firstExisting("ModelsDirectory", True)
        if models:
            args += ["--models", quote(models)]
        ort = self.firstExisting("OnnxRuntimeLibrary", False)
        if ort:
            args += ["--ort", quote(ort)]

        # the worker's GPU affinity (its own, or the job's override): one card per task, by the task's thread
        if self.OverrideGpuAffinity():
            gpus = list(self.GpuAffinity())
            if gpus:
                gpu = gpus[self.GetThreadNumber() % len(gpus)]
                # loop: NOT-WORTH — the worker's few cards, once per task
                self.LogInfo("GPU affinity %s: this task uses card %d" % (",".join(str(g) for g in gpus), gpu))
                args += ["--gpu", str(gpu)]

        extra = self.GetPluginInfoEntryWithDefault("ExtraArguments", "").strip()
        if extra:
            args.append(extra)
        return " ".join(args)

    def HandleProgress(self):
        self.SetProgress(float(self.GetRegexMatch(1)))

    def HandleStatus(self):
        self.SetStatusMessage(self.GetRegexMatch(1))

    def HandleError(self):
        # the CLI exits non-zero right after this line; CheckExitCode fails the task with it
        self.errorLine = self.GetRegexMatch(1)
        self.SetStatusMessage(self.errorLine)

    def CheckExitCode(self, exitCode):
        if exitCode == 0:
            return
        meaning = EXIT_MEANINGS.get(exitCode, "unexpected exit code")
        self.FailRender("corridorkey exited %d (%s): %s" % (exitCode, meaning, self.errorLine or "no ERROR line; see the log"))
