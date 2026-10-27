# Outputs

Set per clip, in the **Outputs** section: which files, the format, and for video the codec.

## The files

| Output | What it is |
| --- | --- |
| **Alpha** | the matte |
| **Foreground** | the predicted foreground colour |
| **Checker** | the foreground over a checkerboard, despilled: a quick preview |
| **Cutout** | the despilled colour, premultiplied by the matte |

Alpha and Foreground are on by default. **Despill** (0.5 by default) applies to the Checker and Cutout only.

## EXR sequence: the exact deliverable

Pick **EXR sequence** under **Format** for compositing. EXR frames are scene-linear and unclamped (HDR), with no
video coding in between. **EXR pixel type** is **half** (the default) or **float**.

Each output is a folder of frames, `<clip>_<output>_exr/`, with the frames named the studio way:

- `<clip>_<output>.<number>.exr`, for example `shot01_alpha.1001.exr`.
- A **video** counts from **1001**, the VFX convention.
- A **frame folder** keeps its own frame numbers and padding (at least 4 digits): `04_5d_00065.exr` gives
  `04_5d_alpha.00065.exr`. If a frame has no number, or the numbers don't go up, it counts from 1001 instead and
  the log says why. `<clip>_settings.txt` records which numbering was used.

What's inside:

- **Alpha:** the matte alone, stored as the EXR's alpha channel `A` (Nuke and OpenImageIO read it as alpha).
- **Cutout:** RGBA, **premultiplied** (RGB × alpha), as EXR and Nuke expect.
- **Foreground** and **Checker:** RGB.

This differs on purpose from the original CorridorKey's EXR writer (which numbers from 0, stores the matte as `Y`
and writes a straight cutout); the matte values themselves are the same. The README explains it in
[EXR outputs a compositor can read as they are](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/README.md#exr-outputs-a-compositor-can-read-as-they-are-10).

For a frame folder input, the app needs to know whether the frames are scene-linear (**Frame folder → Color → Frames
are scene-linear**). A folder of EXR frames starts with it on, PNG/JPEG with it off; change it if your frames differ
(new frame folders then start with your choice). The `corridorkey` command line reads a frame folder the same way:
scene-linear when its first frame is EXR, display-coded otherwise, unless given `--linear` or `--no-linear`. Copy as
command writes the box for an EXR folder both ways (`--linear` or `--no-linear`), for other frames `--linear` when on.

## Video, 10-bit

Pick **Video, 10-bit** for files an editor or a review tool can play. Video outputs are display-referred
(sRGB / Rec.709), 10-bit 4:4:4, encoded straight from the engine's 16-bit render. Choose the **Codec**:

| Codec | File | What it means |
| --- | --- | --- |
| **Lossless H.264, 10-bit 4:4:4** (the default) | `.mp4` | Only the 10-bit rounding is lost. Large files, and the slowest to encode at 4K. |
| **DNxHR 444, 10-bit** | `.mov` | Avid's edit and finishing codec. The matte stays within 1.3/255. |
| **H.264 CRF 12** | `.mp4` | The original CorridorKey's output: small files, but hair edges can be off by up to 21/255. |

How much each codec loses, and how big and fast it is, is measured in the README:
[Video outputs](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/README.md#video-outputs-lossless-h264-dnxhr-444-or-h264-crf-12-10).

**DNxHR 444 needs a frame of at least 256×120 pixels** (ffmpeg's DNxHR encoder refuses anything smaller). A smaller
clip is refused before keying starts; use H.264 for it, which takes any size.

### The video cutout and its alpha

None of these codecs carries an alpha channel. So a video **Cutout** is the despilled colour premultiplied by the
matte, and its alpha is the **Alpha** output: while Cutout is on, Alpha stays on too. A compositor reads the pair as
a premultiplied image plus its matte. **Cutout color** can be **Scene-linear instead of sRGB**. For an RGBA cutout
in one file, choose EXR.

## Which one should I pick?

| You're working in | Pick |
| --- | --- |
| **Nuke** (or any compositor) | **EXR sequence**: scene-linear, the matte in the alpha channel, the cutout premultiplied, frames numbered as the source. |
| **DaVinci Resolve**, Fusion or Color page | **EXR sequence** for the exact result, or **DNxHR 444** (`.mov`) for a lighter video pair. Resolve reads DNxHR in a `.mov`. |
| **An editor** (cutting with the matte) | **DNxHR 444**: an edit and finishing codec, with the matte within 1.3/255. Use the Alpha output as the cutout's matte. |
| Quick review, or smallest files | **H.264 CRF 12**, knowing hair edges lose detail. |
| The most exact video file | **Lossless H.264**, if file size and 4K encode time don't matter. |

## The settings file

Every job writes `<clip>_settings.txt` next to its outputs: the settings the engine really used (window, scale, EXR
numbering, decoders and so on), so a result can always be traced back.
