// CorridorKey job type for Flamenco 3.x: corridorkey render (one task per shot, or chunks with warm-up frames), then
// corridorkey verify. docs/CLI.md is the contract; farm/README.md "Flamenco" says how to install it.

const JOB_TYPE = {
  label: "CorridorKey",
  description: "Key a shot with CorridorKey's corridorkey command, then check every frame",
  settings: [
    { key: "corridorkey", type: "string", subtype: "file_path", required: true, default: "corridorkey", description: "The corridorkey command on the Workers (on PATH, or its full path)" },
    { key: "input", type: "string", subtype: "file_path", required: true, description: "The clip: a movie, a frame folder, or a plate pattern (plates/sh010.####.exr)" },
    {
      key: "output",
      type: "string",
      subtype: "file_path",
      required: true,
      description: "A folder (the app's layout inside it), or one file per frame: key.####.exr, key.%04d.exr. A report goes beside it",
    },
    { key: "outputs", type: "string", required: true, default: "alpha,fg", description: "What to write, comma-separated: alpha, fg, cutout, checker" },
    {
      key: "linear",
      type: "string",
      default: "auto",
      choices: ["auto", "scene-linear", "display-coded"],
      description: "How a frame folder is read: auto by its first frame (EXR scene-linear, others display-coded), or as chosen",
    },
    {
      key: "frames",
      type: "string",
      default: "",
      description: "Frames to key, such as 1001-1100 (the shot's own numbers; a movie's count from 1001). Empty: the whole shot",
    },
    {
      key: "chunk_size",
      type: "int32",
      default: 0,
      propargs: { min: 0 },
      description: "Frames per task. 0: the whole range in one task (the app's matte, bit for bit). Chunks are near-identical, not identical",
    },
    {
      key: "preroll",
      type: "int32",
      default: 0,
      propargs: { min: 0 },
      description: "Chunks only: warm-up frames keyed before each chunk and never written. The value that hides the seams is not measured yet",
    },
    { key: "tail", type: "int32", default: 0, propargs: { min: 0 }, description: "Chunks only: frames keyed after each chunk and never written" },
    {
      key: "existing",
      type: "string",
      // overwrite: Flamenco retries a failed task, and the retry must replace the frames its first try renamed into
      // place (refuse would fail every retry with exit 4), as every other submitter does
      default: "overwrite",
      choices: ["overwrite", "skip-existing", "refuse"],
      description: "Frames already there: overwrite (a retried task replaces its first try's), skip-existing (nothing to do when all are whole), refuse (the task fails, exit 4)",
    },
    { key: "models", type: "string", subtype: "dir_path", required: true, description: "The CorridorKey model set's folder on the Workers" },
    { key: "ort", type: "string", subtype: "file_path", required: true, description: "ONNX Runtime's library on the Workers (libonnxruntime.so / onnxruntime.dll)" },
    { key: "extra_args", type: "string", default: "", description: "More corridorkey render flags, as typed in a shell (--low-vram, --max-vram 10)" },
  ],
};

function compileJob(job) {
  const s = job.settings;
  // a frame list in Blender's notation (1001..1100) becomes the command line's (1001-1100)
  const frames = (s.frames || "").trim().replaceAll("..", "-");
  if (!frames && s.chunk_size > 0) {
    throw "Chunks need a frame range: set Frames (such as 1001-1100), or Chunk Size 0 for the whole shot";
  }
  const parts = s.chunk_size > 0 ? frameChunker(frames, s.chunk_size) : [frames];

  const common = ["--input", s.input, "--output", s.output, "--outputs", s.outputs];
  const verifyTask = author.Task("verify", "misc");
  verifyTask.addCommand(author.Command("exec", { exe: s.corridorkey, args: ["verify"].concat(common, frames ? ["--frames", frames] : []) }));

  // loop: NOT-WORTH — one pass over the job's chunks, once when the Manager compiles the job
  for (const part of parts) {
    const args = ["render"].concat(common, ["--models", s.models, "--ort", s.ort, "--progress-format", "plain", "--report", reportPath(s.output, part)]);
    if (part) {
      args.push("--frames", part);
      if (s.chunk_size > 0) args.push("--preroll", String(s.preroll), "--tail", String(s.tail));
    }
    if (s.linear === "scene-linear") args.push("--linear");
    if (s.linear === "display-coded") args.push("--no-linear");
    if (s.existing !== "refuse") args.push(`--${s.existing}`);
    args.push.apply(args, shellSplit(s.extra_args || ""));

    const task = author.Task(part ? `key-${part}` : "key", "misc");
    task.addCommand(author.Command("exec", { exe: s.corridorkey, args: args }));
    job.addTask(task);
    verifyTask.addDependency(task);
  }
  job.addTask(verifyTask);
}

// The run's report beside the output: in the folder, or beside the frame pattern; one per chunk.
function reportPath(output, part) {
  const name = part ? `corridorkey_report.${part.replaceAll(",", "_")}.json` : "corridorkey_report.json";
  if (/[\\/]$/.test(output)) return output + name;
  const slash = Math.max(output.lastIndexOf("/"), output.lastIndexOf("\\"));
  const isPattern = /#|%0?\d*d|\$F/.test(output.slice(slash + 1));
  return isPattern ? output.slice(0, slash + 1) + name : output + "/" + name;
}
