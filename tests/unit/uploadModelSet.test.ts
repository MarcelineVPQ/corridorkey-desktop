// tools/upload_model_set.sh against a stand-in `gh` (whole-code review 2026-10-27): a release file of the same name and
// size but another SHA-256 is uploaded again (it used to be kept, and the run ended in a mismatch), and the notes'
// SHA-256 list is rewritten on every run (it used to be written only when the release was created).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../tools/upload_model_set.sh", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "ck-upload-model-set-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// gh as the script calls it; the release's state in $FAKE (exists, assets, notes, log)
const GH = `#!/usr/bin/env bash
set -euo pipefail
case "$2" in
  download) shift 2; while [ $# -gt 0 ]; do [ "$1" = -p ] && echo "licence text" > "$2"; shift; done ;;
  view) if [ "$#" -le 5 ]; then [ -e "$FAKE/exists" ]; else cat "$FAKE/assets"; fi ;;
  edit | create) echo "$2" >> "$FAKE/log"; touch "$FAKE/exists"; while [ $# -gt 0 ]; do [ "$1" = --notes-file ] && cp "$2" "$FAKE/notes"; shift; done ;;
  upload)
    f="$7"; echo "upload $f" >> "$FAKE/log"
    grep -v "^$f " "$FAKE/assets" > "$FAKE/assets.new" || true
    echo "$f $(stat -c %s "$f") sha256:$(sha256sum "$f" | cut -d' ' -f1)" >> "$FAKE/assets.new"
    mv "$FAKE/assets.new" "$FAKE/assets" ;;
esac
`;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// the tool runs on the Linux release PC (GNU stat -c, sha256sum)
describe.skipIf(process.platform !== "linux")("upload_model_set.sh", () => {
  it("uploads a same-size file whose SHA-256 differs, keeps the rest, and rewrites the notes", () => {
    const bin = join(scratch, "bin");
    const dir = join(scratch, "set");
    const fake = join(scratch, "fake");
    // loop: NOT-WORTH — three folders
    for (const d of [bin, dir, fake]) mkdirSync(d, { recursive: true });
    writeFileSync(join(bin, "gh"), GH);
    chmodSync(join(bin, "gh"), 0o755);
    const files: Record<string, string> = {
      "ck2-a-trt-fp16.onnx": "network A\n",
      "ck2-a-trt-fp16.onnx.data": "weights A\n",
      "ck2-a-trt-fp16-ctx.onnx": "context A\n",
      "models.json": "{}\n",
    };
    // loop: NOT-WORTH — four fixture files
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const licences = ["ATTRIBUTION.md", "LICENSE", "NOTICE", "LICENSE-Apache-2.0.txt", "LICENSE-MIT-MoGe.txt", "LICENSE-NVIDIA-OPEN-MODEL-2024-06.pdf", "LICENSE-NVIDIA-OPEN-MODEL-2024-06.txt"];
    // the published release: every file as here, except the weights replaced by the same number of other bytes
    // loop: NOT-WORTH — eleven asset lines
    const assets = [
      ...Object.entries(files).map(([name, text]) => `${name} ${text.length} sha256:${name.endsWith(".data") ? sha("weights B\n") : sha(text)}`),
      ...licences.map((name) => `${name} 13 sha256:${sha("licence text\n")}`),
    ];
    writeFileSync(join(fake, "assets"), assets.join("\n") + "\n");
    writeFileSync(join(fake, "exists"), "");
    // loop: NOT-WORTH — one run of the script with the stand-in gh, 30 s deadline
    const r = spawnSync("bash", [script, dir, "2.0.0-onnx.5-trt"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake } });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(readFileSync(join(fake, "log"), "utf8")).toBe("edit\nupload ck2-a-trt-fp16.onnx.data\n");
    const notes = readFileSync(join(fake, "notes"), "utf8");
    expect(notes).toContain(`${sha("weights A\n")}  ck2-a-trt-fp16.onnx.data`);
    // a derived set has no manifest.json: its notes say the ATTRIBUTION.md they carry points at the base set's (release review 2026-10-28)
    expect(notes).toContain("manifest.json (https://github.com/MarcelineVPQ/corridorkey-desktop/releases/tag/models-2.0.0-onnx.5)");
    expect(notes).toContain("its own files are listed in `models.json`");
  });
});
