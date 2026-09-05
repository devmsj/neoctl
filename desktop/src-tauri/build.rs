mod control_config;

fn main() {
    println!("cargo:rerun-if-env-changed=NEO_CONTROL_BUILD_CONFIG");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=control_config.rs");
    let path = std::env::var_os("NEO_CONTROL_BUILD_CONFIG").map(std::path::PathBuf::from);
    if let Some(path) = &path {
        // Paths, unlike contents, are required by Cargo's dependency tracker.
        let text = path.to_str().expect("Control config: build path must be UTF-8");
        assert!(!text.is_empty() && !text.contains(['\r', '\n']), "Control config: invalid build path");
        println!("cargo:rerun-if-changed={text}");
    }
    let config = control_config::load(path.as_deref()).unwrap_or_else(|error| panic!("{error}"));
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR missing"));
    std::fs::write(output.join("control-config.json"), config)
        .expect("Control config: cannot write build output");
    tauri_build::build()
}
