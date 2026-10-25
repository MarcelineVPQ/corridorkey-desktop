# Contributing

Thank you for wanting to help. CorridorKey Desktop is free and stays free, and it is built to a high standard:
every claim is measured, every change is tested.

- **Bugs:** open an issue with the bug form (the engine log and the job's settings file help most).
- **Questions, ideas, results:** [Discussions](https://github.com/MarcelineVPQ/corridorkey-desktop/discussions).
- **Pull requests:** small and focused, one change each. Before opening one:
  - `npm run check` (types, formatting, the theme and loop gates, unit tests) and, for engine changes,
    `npm run check:engine` and `npm run check:targets` must pass;
  - a fix comes with a test that fails without it;
  - anything that changes speed or mattes comes with numbers (tools/engine_bench.mjs, tools/matte_compare.py), and
    mattes may not change unless that's the point of the change;
  - the project's conventions are in CLAUDE.md (one theme, a verdict on every loop, isolated test copies).
- Reviews can take some days. Changes that don't fit the app's direction may be declined, with a reason.

By contributing you agree that your contribution is released under this repository's licence (LICENSE).
