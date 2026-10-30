# TensorRT (Linux)

TensorRT is NVIDIA's optimizer for its graphics cards. With it on, CorridorKey optimizes its networks for your card,
once per resolution range, and then keys faster, with the same mattes as CUDA. It's optional and **off by default**.

How much faster, and what it costs in graphics memory, was measured on an RTX 5080 in the engineering notes:
[TensorRT on onnx.4](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/ENGINEERING.md#008-dev-tensorrt-on-onnx4-2026-10-25)
and [the same-day pair](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/ENGINEERING.md#008-dev-re-measured-the-same-day-pair-on-onnx4-2026-10-26).
Other cards and sizes weren't measured. It's best on cards with 16 GB.

**Linux only in this version.** On Windows it needs its own engine builder, which comes later; Macs have no NVIDIA
graphics. Jobs there run on CUDA.

## Switching it on

1. Finish the normal setup first (the GPU runtime and the models).
2. Open the **Engine** page's settings panel, **TensorRT**, and tick **Use TensorRT (NVIDIA)**.
3. Press **Download and install**. TensorRT has its own download:
   - NVIDIA's TensorRT 10.16 libraries (NVIDIA licence), from pypi.nvidia.com;
   - ONNX Runtime's TensorRT part, from pypi.org (only if your runtime was installed before 1.0);
   - the TensorRT models: the same CorridorKey networks, prepared for TensorRT, from this project's GitHub releases.
     The largest file is copied from the models you already have instead of being downloaded.
     They go into the folder of the model set chosen in Engine settings, **Model set**: 2.0.0-onnx.4 gets its own
     TensorRT set, 2.0.0-onnx.4-trt; 2.0.0-onnx.5 uses the same 2.0.0-onnx.4-trt for now (onnx.5's own TensorRT set
     isn't measured yet). After switching sets, press **Download and install** again: the TensorRT models go into the
     new set's folder (the libraries stay), and until then jobs run on CUDA.

   Like the first install it shows its progress, can be stopped and resumed, and checks every file's SHA-256. The
   button shows the size; the download and disk sizes are in the engineering notes'
   [Requirements](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/ENGINEERING.md#requirements).

Until the parts are installed, jobs run on CUDA.

## Builds in the background, per resolution range

TensorRT has to build engines for your card before it can key a size. The app does this **in the background**, never
inside a job:

- Once TensorRT is installed, it builds **4K DCI** first, then **HD**, with a progress bar in Engine settings
  (which network it's on, how far, how long so far).
- It **pauses while you key** and goes on by itself when the queue stops. If another program is using the graphics
  card, it waits until the card is free; **Build now** starts it anyway. **Stop** keeps what was built.
- **One build per size covers your card.** Each build covers every temporal window a job of that size can pick on
  your card (worked out from the card's total memory, never from what happens to be free while it builds), up to the
  longest measured to build (4K 8 frames, HD 24, built and run on an RTX 5080 16 GB on 2026-10-25).
- **A busy card runs on CUDA.** A job uses its size's engines only when their own memory need fits what the card has
  free; while another program holds the card, the clip runs on CUDA and its page says "the graphics card is busy".
- **Jobs never wait on a build.** A clip whose size isn't built yet runs on CUDA, and its page says so and offers
  **Build it now**: one click starts the same background build for that clip's size, and the next run of the clip
  uses it. A build that runs short of graphics memory says so and offers **Build it again**.

Engine settings, TensorRT lists the common sizes (720p, HD, 2K DCI, 2K full aperture, 2.8K, 4K DCI and UHD) grouped
by range: **tick** a size to build it, **untick** to remove its engines (it asks first). **A size of my own** builds
for any width × height inside TensorRT's ranges. A waiting clip whose size isn't built has **Build for this clip's
size** in its TensorRT section.

Each range shows what it holds once built: the windows it was built for, its size on disk and how long the build
took on your card. The build time and disk space per range were measured in the engineering notes,
[TensorRT on onnx.4](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/ENGINEERING.md#008-dev-tensorrt-on-onnx4-2026-10-25).

The engines are kept in the cache folder (`tensorrt` inside it) and are built again only after a graphics driver,
TensorRT or model update. A range built from other model files (after the model set changed) says
**built for other models · needs a rebuild (the model set changed)**: its clips run on CUDA until it is built again,
which the background build (or its tick, or **Build now**) does.

## Sizes TensorRT takes

TensorRT ranges go up to 4096 pixels a side and 4096×2176 in area: everything from small sizes to DCI 4K and UHD.
**4K open gate (4096×3072), 6K and anything larger run on CUDA.** If a network can't be built for a range (for
example stage 1 at very long windows), that one network runs on CUDA, and the job's log and page say so.

## Windows

A job keys with the same temporal window as on CUDA. A size's engines serve every window up to the one they were
built for (whether a shorter window on longer engines matches CUDA's mattes as exactly as at their own window is not
measured yet), and builds since 1.0.0-dev.7 cover the longest window a job can pick on your card, up to the longest
measured to build. Sizes built by an earlier version were sized from the memory free at that moment and may cover
only shorter windows: a clip with a longer window then runs on CUDA, its page says **TensorRT isn't built for this
clip yet, so this run used CUDA**, and **Build it now** builds the size for your whole card.

Before a clip runs, its **TensorRT** section says what to expect: "On · built for this size", "On · not built for
this size · runs on CUDA", "Outside TensorRT's ranges · CUDA", and so on.

## What really ran

Every job's page has **Technology for this run**: what it ran on (TensorRT, CUDA, or TensorRT with some networks on
CUDA) and, when TensorRT wasn't used, why. The same lines are at the top of the job's log file. See
[Troubleshooting](Troubleshooting#tensorrt-wasnt-used) for every reason.

## Removing it

Untick **Use TensorRT** to stop using it. **App settings → Storage** lists TensorRT as its own item: its libraries
and models (in the data folder) and the engines built for your card (in the cache folder). Remove them there.
