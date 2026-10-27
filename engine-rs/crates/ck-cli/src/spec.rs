//! `corridorkey __spec --json`: the command line's own description as JSON, for tools (the app's Console reads it for
//! completion, hints and checks). Hidden from help; walks the clap builder, so it never drifts from what the parser
//! accepts.
use clap::{Arg, ArgAction, Command};
use serde_json::{json, Value};

/// The hidden subcommand's name.
pub const NAME: &str = "__spec";

/// The whole command line: version, about, and every visible subcommand with its arguments and examples.
pub fn spec(c: &Command) -> Value {
    // loop: NOT-WORTH — four subcommands, once per process
    let commands: Vec<Value> = c.get_subcommands().filter(|s| !s.is_hide_set()).map(command).collect();
    json!({ "version": crate::VERSION, "about": text(c.get_about()), "commands": commands })
}

fn text(s: Option<&clap::builder::StyledStr>) -> Option<String> {
    s.map(|s| s.to_string())
}

fn command(c: &Command) -> Value {
    // loop: NOT-WORTH — a subcommand's ~50 arguments
    let args: Vec<Value> = c.get_arguments().map(|a| arg(c, a)).collect();
    let after = c.get_after_help().map(|s| s.to_string()).unwrap_or_default();
    // the after-help's example lines: the ones that start with the program's name
    // loop: NOT-WORTH — a few lines of help text
    let examples: Vec<&str> = after.lines().map(str::trim).filter(|l| l.starts_with("corridorkey ")).collect();
    json!({ "name": c.get_name(), "about": text(c.get_about()), "args": args, "examples": examples })
}

fn arg(c: &Command, a: &Arg) -> Value {
    let action = a.get_action();
    // loop: NOT-WORTH — a flag's few names and values
    let value_name = a.get_value_names().map(|v| v.iter().map(|s| s.to_string()).collect::<Vec<_>>().join(" "));
    // loop: NOT-WORTH — a flag's few possible values
    let possible: Vec<String> = a.get_possible_values().iter().map(|p| p.get_name().to_string()).collect();
    // loop: NOT-WORTH — a flag's few defaults
    let default: Vec<String> = a.get_default_values().iter().map(|d| d.to_string_lossy().into_owned()).collect();
    // the arguments it can't be used with, as declared (`-s` names `-F`; a tool checks both directions)
    // loop: NOT-WORTH — a flag's one or two conflicts
    let conflicts: Vec<&str> = c.get_arg_conflicts_with(a).iter().map(|x| x.get_id().as_str()).collect();
    json!({
        "id": a.get_id().as_str(),
        "long": a.get_long(),
        "short": a.get_short().map(String::from),
        "positional": a.is_positional(),
        "value_name": value_name,
        "possible_values": possible,
        "help": text(a.get_help()),
        "required": a.is_required_set(),
        "multiple": matches!(action, ArgAction::Append | ArgAction::Count),
        "default": default,
        "takes_value": action.takes_values(),
        "hidden": a.is_hide_set(),
        "conflicts_with": conflicts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::args::{command, RUN_OPTIONS};

    fn find<'a>(cmds: &'a [Value], name: &str) -> &'a Value {
        cmds.iter().find(|c| c["name"] == name).unwrap_or_else(|| panic!("no {name}"))
    }

    #[test]
    fn every_subcommand_and_run_option_is_described() {
        let s = spec(&command());
        assert_eq!(s["version"], crate::VERSION);
        let cmds = s["commands"].as_array().unwrap();
        let names: Vec<&str> = cmds.iter().map(|c| c["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["render", "verify", "prepare", "info"], "and never the hidden {NAME}");
        // loop: NOT-WORTH — four subcommands
        for c in cmds {
            assert!(c["about"].as_str().is_some_and(|a| !a.is_empty()), "{c}");
            assert!(!c["examples"].as_array().unwrap().is_empty(), "{} has examples", c["name"]);
        }
        // loop: NOT-WORTH — the run options' flags, on two subcommands
        for sub in ["render", "verify"] {
            let args = find(cmds, sub)["args"].as_array().unwrap();
            for (flag, _, _, value, help) in RUN_OPTIONS {
                let a = args.iter().find(|a| a["long"] == flag).unwrap_or_else(|| panic!("{sub} --{flag}"));
                assert_eq!(a["help"], help, "{sub} --{flag}");
                assert_eq!(a["takes_value"], !value.is_empty(), "{sub} --{flag}");
            }
        }
        let render = find(cmds, "render")["args"].as_array().unwrap();
        let frames = render.iter().find(|a| a["long"] == "frames").unwrap();
        assert_eq!((frames["short"].as_str(), frames["multiple"].as_bool(), frames["value_name"].as_str()), (Some("F"), Some(true), Some("SPEC")));
        let pf = render.iter().find(|a| a["long"] == "progress-format").unwrap();
        assert_eq!(pf["possible_values"].as_array().unwrap().len(), crate::progress::Format::NAMES.len());
        let clip = render.iter().find(|a| a["id"] == "clip").unwrap();
        assert_eq!((clip["positional"].as_bool(), clip["long"].is_null()), (Some(true), true));
        assert_eq!(render.iter().find(|a| a["long"] == "overwrite").unwrap()["takes_value"], false);
        assert!(find(cmds, "info")["args"].as_array().unwrap().iter().any(|a| a["long"] == "json"));
        assert!(find(cmds, "prepare")["args"].as_array().unwrap().iter().any(|a| a["long"] == "tensorrt-size"));
        // the conflicts the parser enforces (the Console marks them before Enter)
        let conflicts = |id: &str| render.iter().find(|a| a["id"] == id).unwrap()["conflicts_with"].clone();
        assert_eq!(conflicts("start"), json!(["frames"]));
        assert_eq!(conflicts("end"), json!(["frames"]));
        assert_eq!(conflicts("skip-existing"), json!(["overwrite"]));
        assert_eq!(conflicts("quiet"), json!(["verbose"]));
        assert_eq!(conflicts("input"), json!(["clip"]));
        assert_eq!(conflicts("frames"), json!([]));
    }
}
