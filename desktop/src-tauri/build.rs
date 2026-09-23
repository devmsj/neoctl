fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().plugin(
        "local-resources",
        tauri_build::InlinedPlugin::new().commands(&[
            "reveal_file",
            "watch_file_drops",
            "unwatch_file_drops",
            "take_file_drop",
        ]),
    ))
    .expect("failed to build desktop capabilities");
}
