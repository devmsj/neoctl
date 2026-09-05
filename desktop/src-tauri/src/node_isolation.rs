//! Dependency-management isolation, not a sandbox. Lifecycle scripts still have the user's
//! filesystem/network privileges. Runtime PATH deliberately retains git/python and other tools.
//! Arbitrary user workspaces may supply their own project .npmrc; the managed install and launch
//! working directories below have a package boundary and controlled local .npmrc.
//! npm may prepend dependency-local .bin directories for lifecycle scripts; these are trusted
//! package code, not sandboxed. Install path preflight rejects ancestor runtime-manager shims.
//! HOME/USERPROFILE and HTTP(S)_PROXY are retained; no proxy address is written here.
use std::{collections::BTreeMap, ffi::OsString, fs, path::Path, process::Command};

#[derive(Clone, Copy)]
pub(super) enum Phase {
    Install,
    Runtime,
}

fn injected(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    [
        "NPM_",
        "NVM_",
        "NODE_",
        "COREPACK_",
        "VOLTA_",
        "PNPM_",
        "YARN_",
    ]
    .iter()
    .any(|p| key.starts_with(p))
        || matches!(
            key.as_str(),
            "NODE"
                | "NODEJS"
                | "PREFIX"
                | "DESTDIR"
                | "INIT_CWD"
                | "GYP_DEFINES"
                | "GYP_MSVS_OVERRIDE_PATH"
                | "GYP_MSVS_VERSION"
        )
}

/// Snapshot and overlay command-specific variables before clearing *only this child*.
/// This also makes mixed-case pollution tests independent of the test runner's environment.
fn child_environment(command: &Command) -> BTreeMap<String, (OsString, OsString)> {
    let mut env = BTreeMap::new();
    for (key, value) in std::env::vars_os() {
        env.insert(key.to_string_lossy().to_ascii_uppercase(), (key, value));
    }
    for (key, value) in command.get_envs() {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if let Some(value) = value {
            env.insert(upper, (key.into(), value.into()));
        } else {
            env.remove(&upper);
        }
    }
    env
}

pub(super) fn configure(
    command: &mut Command,
    root: &Path,
    runtime: &Path,
    cwd: &Path,
    phase: Phase,
) -> Result<(), String> {
    if !root.is_absolute() || !runtime.is_absolute() || !cwd.is_absolute() {
        return Err("Node isolation requires absolute paths".into());
    }
    let private = root.join(".neo-node");
    let marker = private.join(".neo-owned");
    if private.exists()
        && fs::read_to_string(&marker).unwrap_or_default() != "neoctl-desktop-node-v1"
    {
        return Err("Unknown Node isolation directory".into());
    }
    fs::create_dir_all(&private).map_err(|e| e.to_string())?;
    fs::write(marker, "neoctl-desktop-node-v1").map_err(|e| e.to_string())?;
    for dir in ["cache", "prefix", "node-gyp"] {
        fs::create_dir_all(private.join(dir)).map_err(|e| e.to_string())?;
    }
    // Empty, controlled files: never read/write the host's .npmrc and never persist staging paths.
    for file in ["user.npmrc", "global.npmrc"] {
        fs::write(private.join(file), "# Managed by Neo Desktop\n").map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(cwd).map_err(|e| e.to_string())?;
    let manifest = cwd.join("package.json");
    if !manifest.exists() {
        fs::write(
            &manifest,
            "{\"name\":\"neoctl-desktop-data\",\"private\":true}\n",
        )
        .map_err(|e| e.to_string())?;
    }
    fs::write(
        cwd.join(".npmrc"),
        "# Managed project boundary; do not inherit ancestor npm settings\n",
    )
    .map_err(|e| e.to_string())?;
    let env = child_environment(command);
    let mut paths = vec![runtime.join("node")];
    #[cfg(windows)]
    {
        // Obtain Windows itself, not a PATH lookup of cmd.exe (ComSpec may be polluted).
        let mut buffer = [0u16; 32768];
        #[link(name = "kernel32")]
        extern "system" {
            fn GetWindowsDirectoryW(buffer: *mut u16, size: u32) -> u32;
        }
        let length =
            unsafe { GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
        if length == 0 || length >= buffer.len() {
            return Err("Cannot locate Windows directory".into());
        }
        let windows = std::path::PathBuf::from(String::from_utf16_lossy(&buffer[..length]));
        let system = windows.join("System32");
        paths.extend([
            system.clone(),
            windows.clone(),
            system.join("Wbem"),
            system.join("WindowsPowerShell").join("v1.0"),
        ]);
    }
    if matches!(phase, Phase::Runtime) {
        if let Some((_, path)) = env.get("PATH") {
            paths.extend(std::env::split_paths(path).filter(|p| p.is_absolute()));
        }
    }
    command.env_clear();
    for (upper, (key, value)) in &env {
        if !injected(upper) && !matches!(upper.as_str(), "PATH" | "COMSPEC" | "PATHEXT") {
            command.env(key, value);
        }
    }
    #[cfg(windows)]
    {
        command.env("ComSpec", paths[1].join("cmd.exe"));
        command
            .env("SystemRoot", &paths[2])
            .env("WINDIR", &paths[2]);
        command.env("PATHEXT", ".COM;.EXE;.BAT;.CMD");
        command.env("npm_config_script_shell", paths[1].join("cmd.exe"));
    }
    command
        .env(
            "PATH",
            std::env::join_paths(paths).map_err(|e| e.to_string())?,
        )
        .env("npm_config_userconfig", private.join("user.npmrc"))
        .env("npm_config_globalconfig", private.join("global.npmrc"))
        .env("npm_config_cache", private.join("cache"))
        .env("npm_config_prefix", private.join("prefix"))
        .env("npm_config_devdir", private.join("node-gyp"))
        .env("npm_config_global", "false")
        .env("npm_config_registry", super::REGISTRY)
        .current_dir(cwd);
    Ok(())
}

#[cfg(all(test, windows))]
#[path = "node_isolation_tests.rs"]
mod tests;
