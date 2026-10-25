# Vendored crates

Third-party crates used from here instead of crates.io, wired in with `[patch.crates-io]` in `engine-rs/Cargo.toml`
and excluded from the workspace (not linted, formatted or tested as ours).

## ocio-sys 0.3.0 (OpenColorIO 2.5.2, BSD-3-Clause)

The FFI layer under `ocio-rs` 0.3.0 (https://github.com/shaloong/ocio-rs), with OpenColorIO 2.5.2 and its
dependencies' sources in `vendor/` (built from source by CMake with the `bundled` feature, linked in statically).
Copied unchanged from the crates.io package (first commit), then patched for cross-building the Windows engine from
Linux with MinGW (backlog row 29; the study: docs/OCIO_STUDY_2026-10.md §2 "Builds"). `ocio-sys.patch` is the whole
change (`git diff` of the second commit), for offering upstream: Marcy sees that PR before it is opened (decision 4).

The fixes, all in `build.rs` except the first:

1. **OCIO's `FileTransform.cpp`** builds an `std::ifstream` from a `std::wstring` on Windows, which MinGW's libstdc++
   has no constructor for: `.c_str()` (the `const wchar_t*` constructor it does have). OpenColorIO issue #2283.
2. **The target, not the host.** `cfg!(target_os = ...)` in a build script is the host's, so a cross-build took Linux's
   link flags (`-lstdc++ -ldl -lpthread`), Linux's library names and no `OpenColorIO_SKIP_IMPORTS`. The script now
   reads `CARGO_CFG_TARGET_OS` / `CARGO_CFG_TARGET_ENV`. Host-only code (finding MSVC, Ninja, the Windows SDK) keeps
   `cfg!`.
3. **`OpenColorIO_SKIP_IMPORTS`** for the static bridge on any Windows target (came with fix 2).
4. **A CMake toolchain file for cross-builds.** OCIO builds its dependencies (yaml-cpp, expat, zlib, minizip-ng,
   pystring, Imath) as ExternalProjects, which inherit only `CMAKE_TOOLCHAIN_FILE`: without one they were built for
   Linux inside the Windows build. When the target differs from the host and no toolchain file is set
   (`CMAKE_TOOLCHAIN_FILE[_<target>]`, `TARGET_CMAKE_TOOLCHAIN_FILE`; cargo-zigbuild sets one for the glibc 2.28 Linux
   build), the script writes one to `OUT_DIR` from the compilers the `cc` crate picks for the target (system name and
   processor, C/C++ compilers, MinGW's `windres` and sysroot).
5. **MinGW archive names and libraries.** MinGW's archives are `libNAME.a` (not `NAME.lib`), zlib's is
   `libzlibstatic.a`; the link gets `bcrypt` (minizip-ng's random source; the study's test program needed it, the
   engine ends up importing nothing from it) and MinGW's `libstdc++.a`, found with the compiler's
   `-print-file-name` (so the engine needs no `libstdc++-6.dll`).

Measured (2026-10-24): the patched crate builds for Linux (native, and cargo-zigbuild for glibc 2.28) and Windows
(MinGW cross-build; the engine needs only Windows' own DLLs). Under Wine the Windows build's processors are
byte-identical to Linux's for every matrix-only colour space and within 7.5e-7 of the pixel's largest channel for
the curve-based ones (tools/ocio_compare.py `--wine`; docs/ENGINE_RUST.md "Colour"). macOS is built only on a Mac
(not verified from this PC).

To update: replace `ocio-sys/` with the new crates.io package, re-apply `ocio-sys.patch` (or drop what upstream took),
and run `tools/build_engine.sh`, `tools/build_engine.sh --windows` and tools/ocio_compare.py.
