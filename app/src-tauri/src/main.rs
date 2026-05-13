// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // CLI subcommands run instead of booting the Tauri GUI. Keep the
    // dispatch trivial: anything added here loads before the heavy
    // Builder setup, so `yiyi doctor` returns in under a second even on
    // a slow disk. The default (no subcommand) is the GUI app.
    let argv: Vec<String> = std::env::args().collect();
    if let Some(sub) = argv.get(1).map(|s| s.as_str()) {
        match sub {
            "doctor" => {
                std::process::exit(app_lib::doctor::run());
            }
            // Future subcommands (`yiyi tail`, `yiyi reset-config`, …) land
            // here. Unknown subcommands fall through to the GUI for now so
            // we don't surprise users who launch the binary with stray args.
            _ => {}
        }
    }
    app_lib::run();
}
