//! corridorkey: CorridorKey on the command line, for render farms and power users (docs/CLI.md).
//!
//!   corridorkey render -i plates/sh010.####.exr -o key/sh010_key.####.exr -F 1001-1100
//!   corridorkey verify | prepare | info | help
//!
//! It links ck-core directly. Unlike the engine (corridorkey-engine) it has no parent-death watch: a farm's launcher
//! may be PID 1, or exit before its task; SIGTERM / SIGINT stop it cleanly (exit 143 / 130).
fn main() {
    std::process::exit(ck_cli::run::main(std::env::args_os().collect()));
}
