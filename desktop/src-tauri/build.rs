fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().plugin(
        "local-resources",
        tauri_build::InlinedPlugin::new().commands(&["reveal_file"]),
    ))
    .expect("failed to build desktop capabilities");
}
