fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .plugin(
                "local-resources",
                tauri_build::InlinedPlugin::new().commands(&[
                    "clipboard_read",
                    "clipboard_write",
                    "reveal_file",
                    "open_external",
                    "watch_file_drops",
                    "unwatch_file_drops",
                    "take_file_drop",
                ]),
            )
            .plugin(
                "desktop-chrome",
                tauri_build::InlinedPlugin::new()
                    .commands(&["window_action", "application_action", "sync_surface", "system_theme"]),
            ),
    )
    .expect("failed to build desktop capabilities");
}
