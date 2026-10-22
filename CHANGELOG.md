# Changelog

## 0.1.0-dev.1 (unreleased)

- First app: clip queue (videos, frame folders, batch folders, companion hints found next to
  clips), per-clip hint/output/memory settings, one engine process for the queue, live progress
  from the engine (stages, frames, measured speed, the memory window used), result stills,
  errors with the engine's output, cancel.
- Engine `engine/ck_engine.py` (protocol 1, JSON lines over stdio) running the upstream
  CorridorKey runtime unchanged.
