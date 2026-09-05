//! Preflight only: callers must prevent concurrent filesystem changes between
//! validation and installation. Ownership markers are conventions, not signatures.
//! Create staging's package.json and .neo-node/.neo-owned before writing payloads.

use std::ffi::OsString;
use std::fs::{self, Metadata};
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

const PACKAGE_NAME: &str = "neoctl-desktop-runtime";
const NODE_OWNER: &str = "neoctl-desktop-node-v1";

pub(super) fn validate_install_dir(path: &Path) -> Result<(), String> {
    let protected: Vec<PathBuf> = ["NVM_HOME", "NVM_SYMLINK", "VOLTA_HOME"]
        .iter()
        .filter_map(std::env::var_os)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .collect();
    validate_with_protected(path, &protected)
}

fn invalid(path: &Path, reason: &str) -> String {
    format!("Unsafe install directory '{}': {reason}", path.display())
}

fn metadata(path: &Path) -> Result<Option<Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(invalid(path, &format!("cannot inspect: {error}"))),
    }
}

fn is_link(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Includes junctions, mount points and other reparse types, not just symlinks.
        meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

fn check_syntax(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(invalid(path, "an absolute path is required"));
    }
    // components() normalizes embedded '.' away, so inspect the original spelling.
    // Reject non-Unicode spellings rather than compare aliases lossily.
    let text = path
        .to_str()
        .ok_or_else(|| invalid(path, "invalid Unicode path"))?;
    let dot = text
        .split(std::path::is_separator)
        .any(|part| part == "." || part == "..");
    if dot
        || path
            .components()
            .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
    {
        return Err(invalid(path, "dot and parent components are not allowed"));
    }
    if !path.components().any(|c| matches!(c, Component::Normal(_))) {
        return Err(invalid(
            path,
            "disk/share roots are not install directories",
        ));
    }
    #[cfg(windows)]
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                use std::path::Prefix;
                if !matches!(prefix.kind(), Prefix::Disk(_) | Prefix::UNC(_, _)) {
                    return Err(invalid(path, "device and verbatim paths are not allowed"));
                }
            }
            Component::Normal(name) => {
                let name = name
                    .to_str()
                    .ok_or_else(|| invalid(path, "invalid path component"))?;
                let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
                let numbered_device = ["COM", "LPT"].iter().any(|prefix| {
                    stem.strip_prefix(prefix).map_or(false, |n| {
                        matches!(
                            n,
                            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                        )
                    })
                });
                if name.ends_with(['.', ' '])
                    || name.chars().any(|c| c < ' ' || "<>:\"|?*".contains(c))
                    || matches!(
                        stem.as_str(),
                        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
                    )
                    || numbered_device
                {
                    return Err(invalid(path, "ambiguous Windows path component"));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn read_marker(path: &Path) -> Result<Option<String>, String> {
    let Some(meta) = metadata(path)? else {
        return Ok(None);
    };
    if is_link(&meta) || !meta.is_file() {
        return Err(invalid(path, "marker must be an ordinary file"));
    }
    // Markers are small; do not consume arbitrarily large files during preflight.
    if meta.len() > 1024 * 1024 {
        return Err(invalid(path, "marker is too large"));
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|e| invalid(path, &format!("cannot read marker: {e}")))
}

fn reject_node_directory(path: &Path) -> Result<(), String> {
    for marker in ["node.exe", "nvm.exe", "npm.cmd"] {
        if metadata(&path.join(marker))?.is_some() {
            return Err(invalid(
                path,
                "existing Node/npm/nvm directory (or descendant)",
            ));
        }
    }
    if let Some(settings) = read_marker(&path.join("settings.txt"))? {
        let settings = settings.to_ascii_lowercase();
        if settings.contains("nvm")
            || settings.lines().any(|line| {
                let line = line.trim_start();
                line.starts_with("root:") || line.starts_with("path:")
            })
        {
            return Err(invalid(
                path,
                "existing nvm settings directory (or descendant)",
            ));
        }
    }
    Ok(())
}

// Resolve the existing prefix, including aliases in environment-supplied paths;
// preserve the missing suffix so a not-yet-created protected directory also counts.
fn resolved(path: &Path) -> Result<PathBuf, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(path)
    };
    let mut prefix = absolute.as_path();
    let mut suffix: Vec<OsString> = Vec::new();
    loop {
        match fs::canonicalize(prefix) {
            Ok(mut result) => {
                for part in suffix.iter().rev() {
                    result.push(part);
                }
                return Ok(result);
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                // A dangling link must not be mistaken for an absent directory.
                if metadata(prefix)?.is_some() {
                    return Err(invalid(prefix, "cannot resolve existing path"));
                }
                let name = prefix
                    .file_name()
                    .ok_or_else(|| invalid(prefix, "cannot resolve path"))?;
                suffix.push(name.to_os_string());
                prefix = prefix
                    .parent()
                    .ok_or_else(|| invalid(prefix, "cannot resolve parent"))?;
            }
            Err(error) => return Err(invalid(prefix, &format!("cannot resolve: {error}"))),
        }
    }
}

fn within(path: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        // Canonicalization resolves short (8.3) names; compare components, not string prefixes.
        let mut parts = path.components();
        root.components().all(|expected| {
            parts.next().map_or(false, |actual| {
                actual.as_os_str().to_string_lossy().to_lowercase()
                    == expected.as_os_str().to_string_lossy().to_lowercase()
            })
        })
    }
    #[cfg(not(windows))]
    {
        path.starts_with(root)
    }
}

fn package_owned(dir: &Path) -> Result<bool, String> {
    let Some(text) = read_marker(&dir.join("package.json"))? else {
        return Ok(false);
    };
    Ok(serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| {
            v.get("name")
                .and_then(|n| n.as_str())
                .map(|n| n == PACKAGE_NAME)
        })
        .unwrap_or(false))
}

fn receipt_owned(dir: &Path) -> Result<bool, String> {
    let Some(text) = read_marker(&dir.join("neo-desktop-runtime.json"))? else {
        return Ok(false);
    };
    Ok(serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("schema").and_then(|s| s.as_u64()))
        == Some(1))
}

fn reject_tree_links(dir: &Path) -> Result<(), String> {
    let mut pending = vec![dir.to_path_buf()];
    while let Some(path) = pending.pop() {
        let meta = metadata(&path)?
            .ok_or_else(|| invalid(&path, "entry disappeared during validation"))?;
        if is_link(&meta) {
            return Err(invalid(
                &path,
                "symlink/reparse entries are not allowed in managed directories",
            ));
        }
        if meta.is_dir() {
            for entry in fs::read_dir(&path).map_err(|e| invalid(&path, &e.to_string()))? {
                pending.push(entry.map_err(|e| invalid(&path, &e.to_string()))?.path());
            }
        } else if !meta.is_file() {
            return Err(invalid(&path, "special filesystem entries are not allowed"));
        }
    }
    Ok(())
}

const DATA_NPMRC: &str = "# Managed project boundary; do not inherit ancestor npm settings\n";

// Inspect only npm's executable search locations, never recurse into workspaces.
fn reject_ancestor_shims(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let modules = ancestor.join("node_modules");
        let bin = modules.join(".bin");
        for dir in [&modules, &bin] {
            if let Some(meta) = metadata(dir)? {
                if is_link(&meta) || !meta.is_dir() {
                    return Err(invalid(
                        dir,
                        "npm search directory must not be a reparse point or file",
                    ));
                }
            }
        }
        for name in ["node", "npm", "npx", "corepack", "nvm"] {
            for extension in ["", ".exe", ".cmd", ".bat", ".com", ".ps1"] {
                let shim = bin.join(format!("{name}{extension}"));
                if metadata(&shim)?.is_some() {
                    return Err(invalid(
                        &shim,
                        "ancestor npm runtime shim would override isolated Node",
                    ));
                }
            }
        }
    }
    Ok(())
}

fn validate_data(root: &Path) -> Result<(), String> {
    let data = root.join("data");
    if let Some(meta) = metadata(&data)? {
        if is_link(&meta) || !meta.is_dir() {
            return Err(invalid(&data, "data must be an ordinary directory"));
        }
        if let Some(text) = read_marker(&data.join(".npmrc"))? {
            if text != DATA_NPMRC {
                return Err(invalid(
                    &data.join(".npmrc"),
                    "unrecognized managed npm boundary",
                ));
            }
        }
        if let Some(text) = read_marker(&data.join("package.json"))? {
            let owned = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| {
                    v.get("name")
                        .and_then(|n| n.as_str())
                        .map(|n| n == "neoctl-desktop-data")
                })
                .unwrap_or(false);
            if !owned {
                return Err(invalid(
                    &data.join("package.json"),
                    "unrecognized data package",
                ));
            }
        }
    }
    reject_ancestor_shims(&data)
}

fn validate_with_protected(path: &Path, protected: &[PathBuf]) -> Result<(), String> {
    check_syntax(path)?;
    for ancestor in path.ancestors() {
        if let Some(meta) = metadata(ancestor)? {
            if is_link(&meta) || !meta.is_dir() {
                return Err(invalid(
                    ancestor,
                    "install path and ancestors must be ordinary directories",
                ));
            }
            reject_node_directory(ancestor)?;
        }
    }
    validate_data(path)?;
    let target = resolved(path)?;
    for root in protected {
        if within(&target, &resolved(root)?) {
            return Err(invalid(path, "inside NVM_HOME, NVM_SYMLINK or VOLTA_HOME"));
        }
    }
    for name in [
        "runtime",
        ".runtime-staging",
        ".runtime-previous",
        ".neo-node",
    ] {
        let dir = path.join(name);
        let Some(meta) = metadata(&dir)? else {
            continue;
        };
        if is_link(&meta) || !meta.is_dir() {
            return Err(invalid(
                &dir,
                "reserved path must be an ordinary owned directory",
            ));
        }
        let owned = if name == ".neo-node" {
            read_marker(&dir.join(".neo-owned"))?.map_or(false, |text| text == NODE_OWNER)
        } else {
            package_owned(&dir)? && (name == ".runtime-staging" || receipt_owned(&dir)?)
        };
        if !owned {
            return Err(invalid(
                &dir,
                "unrecognized ownership; refusing to overwrite or remove existing contents",
            ));
        }
        reject_tree_links(&dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let base = fs::canonicalize(std::env::temp_dir()).unwrap();
            // Windows canonicalize adds a verbatim prefix; tests use ordinary paths.
            #[cfg(windows)]
            let base = PathBuf::from(base.to_str().unwrap().trim_start_matches(r"\\?\"));
            let path = base.join(format!(
                "neo-install-test-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn dir(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(&path).unwrap();
            path
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn valid(path: &Path) -> bool {
        validate_with_protected(path, &[]).is_ok()
    }
    fn package(dir: &Path) {
        fs::write(
            dir.join("package.json"),
            r#"{"name":"neoctl-desktop-runtime"}"#,
        )
        .unwrap();
    }

    #[test]
    fn absolute_specific_paths_only() {
        let temp = Temp::new();
        assert!(valid(&temp.0));
        assert!(valid(&temp.0.join("new").join("nested")));
        assert!(!valid(Path::new("")));
        assert!(!valid(Path::new("relative/install")));
        assert!(!valid(temp.0.ancestors().last().unwrap()));
        assert!(!valid(&temp.0.join("./child")));
        assert!(!valid(&temp.0.join("child/../other")));
        fs::write(temp.0.join("file"), "data").unwrap();
        assert!(!valid(&temp.0.join("file")));
        assert!(!valid(&temp.0.join("file/child")));
    }

    #[test]
    fn node_markers_protect_directories_and_descendants() {
        for marker in ["node.exe", "nvm.exe", "npm.cmd", "settings.txt"] {
            let temp = Temp::new();
            fs::write(temp.0.join(marker), "root: C:\\nvm\npath: C:\\nodejs").unwrap();
            assert!(!valid(&temp.0), "{marker}");
            assert!(!valid(&temp.0.join("new/child")), "{marker}");
        }
        let temp = Temp::new();
        fs::write(temp.0.join("settings.txt"), "theme=dark").unwrap();
        assert!(valid(&temp.0));
    }

    #[test]
    fn injected_environment_roots_need_no_global_mutation() {
        let temp = Temp::new();
        for name in ["nvm-home", "nvm-symlink", "volta-home"] {
            let root = temp.dir(name);
            let protected = vec![root.clone()];
            assert!(validate_with_protected(&root, &protected).is_err());
            assert!(validate_with_protected(&root.join("missing/child"), &protected).is_err());
            assert!(
                validate_with_protected(&temp.0.join(format!("{name}-other")), &protected).is_ok()
            );
            fs::remove_dir(&root).unwrap();
            assert!(validate_with_protected(&root.join("child"), &protected).is_err());
        }
    }

    #[test]
    fn reserved_directories_require_ownership_even_when_empty() {
        for name in [
            "runtime",
            ".runtime-staging",
            ".runtime-previous",
            ".neo-node",
        ] {
            let temp = Temp::new();
            let dir = temp.dir(name);
            assert!(!valid(&temp.0), "{name}");
            fs::write(dir.join("keep.txt"), "user data").unwrap();
            assert!(!valid(&temp.0));
            assert_eq!(
                fs::read_to_string(dir.join("keep.txt")).unwrap(),
                "user data"
            );
        }
    }

    #[test]
    fn runtime_and_previous_require_both_parsed_markers() {
        for name in ["runtime", ".runtime-previous"] {
            let temp = Temp::new();
            let dir = temp.dir(name);
            package(&dir);
            assert!(!valid(&temp.0));
            for receipt in ["not json", r#"{"schema":"1"}"#, r#"{"schema":2}"#, "{}"] {
                fs::write(dir.join("neo-desktop-runtime.json"), receipt).unwrap();
                assert!(!valid(&temp.0));
            }
            fs::write(dir.join("neo-desktop-runtime.json"), r#"{"schema":1}"#).unwrap();
            assert!(valid(&temp.0));
            for manifest in ["broken", r#"{"name":"some-other-package"}"#, "{}"] {
                fs::write(dir.join("package.json"), manifest).unwrap();
                assert!(!valid(&temp.0));
            }
        }
    }

    #[test]
    fn staging_package_is_enough_for_interrupted_copy_retry() {
        let temp = Temp::new();
        let dir = temp.dir(".runtime-staging");
        package(&dir);
        fs::create_dir(dir.join("packages")).unwrap();
        fs::write(dir.join("packages/partial.tgz"), "partial").unwrap();
        assert!(valid(&temp.0));
        fs::write(dir.join("neo-desktop-runtime.json"), "partial receipt").unwrap();
        assert!(valid(&temp.0));
    }

    #[test]
    fn isolated_node_requires_exact_owner() {
        let temp = Temp::new();
        let dir = temp.dir(".neo-node");
        fs::write(dir.join("node.exe"), "payload").unwrap();
        fs::write(dir.join(".neo-owned"), "other-owner").unwrap();
        assert!(!valid(&temp.0));
        fs::write(dir.join(".neo-owned"), format!("{NODE_OWNER}\n")).unwrap();
        assert!(!valid(&temp.0));
        fs::write(dir.join(".neo-owned"), NODE_OWNER).unwrap();
        assert!(valid(&temp.0));
    }

    #[test]
    fn data_boundary_requires_exact_npmrc_and_named_package() {
        let temp = Temp::new();
        let data = temp.dir("data");
        assert!(valid(&temp.0));
        for text in ["", "registry=evil", DATA_NPMRC.trim_end()] {
            fs::write(data.join(".npmrc"), text).unwrap();
            assert!(!valid(&temp.0));
        }
        fs::write(data.join(".npmrc"), DATA_NPMRC).unwrap();
        assert!(valid(&temp.0));
        for text in ["broken", "{}", r#"{"name":"other"}"#] {
            fs::write(data.join("package.json"), text).unwrap();
            assert!(!valid(&temp.0));
        }
        fs::write(
            data.join("package.json"),
            r#"{"name":"neoctl-desktop-data"}"#,
        )
        .unwrap();
        assert!(valid(&temp.0));
    }

    #[test]
    fn ancestor_runtime_shims_rejected_without_workspace_scan() {
        let temp = Temp::new();
        let install = temp.dir("install");
        for parent in [&temp.0, &install, &install.join("data")] {
            let bin = parent.join("node_modules/.bin");
            fs::create_dir_all(&bin).unwrap();
            for name in [
                "node",
                "node.exe",
                "npm.cmd",
                "npx.ps1",
                "corepack.bat",
                "nvm.com",
            ] {
                fs::write(bin.join(name), "shim").unwrap();
                assert!(!valid(&install), "{name}");
                fs::remove_file(bin.join(name)).unwrap();
            }
            fs::write(bin.join("eslint.cmd"), "unrelated").unwrap();
            assert!(valid(&install));
        }
    }

    #[cfg(any(windows, unix))]
    #[test]
    fn data_and_node_config_junctions_rejected_but_workspaces_not_scanned() {
        let temp = Temp::new();
        let outside = temp.dir("outside");
        let install = temp.dir("install");
        directory_link(&install.join("data"), &outside);
        assert!(!valid(&install));
        #[cfg(windows)]
        fs::remove_dir(install.join("data")).unwrap();
        #[cfg(unix)]
        fs::remove_file(install.join("data")).unwrap();
        fs::create_dir(install.join("data")).unwrap();
        directory_link(&install.join("data").join("workspace"), &outside);
        assert!(valid(&install));
        let private = install.join(".neo-node");
        fs::create_dir(&private).unwrap();
        fs::write(private.join(".neo-owned"), NODE_OWNER).unwrap();
        for name in ["config", "cache", "prefix", "node-gyp"] {
            directory_link(&private.join(name), &outside);
            assert!(!valid(&install));
            #[cfg(windows)]
            fs::remove_dir(private.join(name)).unwrap();
            #[cfg(unix)]
            fs::remove_file(private.join(name)).unwrap();
        }
        directory_link(&install.join("data").join("node_modules"), &outside);
        assert!(!valid(&install));
    }

    #[cfg(windows)]
    #[test]
    fn windows_alias_spellings_are_rejected() {
        let temp = Temp::new();
        for name in ["tail.", "tail ", "file:stream", "NUL", "COM1.txt", "LPT¹"] {
            assert!(!valid(&temp.0.join(name)), "{name}");
        }
        for path in [
            r"C:\",
            r"C:relative",
            r"\rooted",
            r"\\server\share\",
            r"\\?\C:\install",
        ] {
            assert!(!valid(Path::new(path)), "{path}");
        }
    }

    #[cfg(windows)]
    fn directory_link(link: &Path, target: &Path) {
        // Junction creation does not require Developer Mode or symlink privilege.
        let output = std::process::Command::new("cmd")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[cfg(unix)]
    fn directory_link(link: &Path, target: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[cfg(any(windows, unix))]
    #[test]
    fn links_in_ancestors_reserved_trees_and_env_aliases() {
        let temp = Temp::new();
        let real = temp.dir("real");
        let alias = temp.0.join("alias");
        directory_link(&alias, &real);
        assert!(!valid(&alias));
        assert!(!valid(&alias.join("missing/child")));
        assert!(validate_with_protected(&real.join("child"), &[alias.clone()]).is_err());
        let install = temp.dir("install");
        let staging = install.join(".runtime-staging");
        directory_link(&staging, &real);
        assert!(!valid(&install));
        #[cfg(windows)]
        fs::remove_dir(&staging).unwrap();
        #[cfg(unix)]
        fs::remove_file(&staging).unwrap();
        fs::create_dir(&staging).unwrap();
        package(&staging);
        directory_link(&staging.join("external"), &real);
        assert!(!valid(&install));
    }
}
