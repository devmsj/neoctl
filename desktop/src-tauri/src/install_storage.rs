//! First-install storage selection. Never migrates an existing installation.
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub(super) fn candidates() -> Vec<PathBuf> {
    candidates_from(
        ["LOCALAPPDATA", "APPDATA", "USERPROFILE"]
            .map(|key| std::env::var_os(key).map(PathBuf::from)),
    )
}

fn candidates_from(bases: [Option<PathBuf>; 3]) -> Vec<PathBuf> {
    let mut result = Vec::new();
    for base in bases.into_iter().flatten().filter(|p| p.is_absolute()) {
        let path = base.join("Neo Desktop Data");
        if !result.iter().any(|p: &PathBuf| same_path(p, &path)) {
            result.push(path);
        }
    }
    result
}

pub(super) fn same_path(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        a.to_string_lossy()
            .replace('/', "\\")
            .to_lowercase()
            .trim_end_matches('\\')
            == b.to_string_lossy()
                .replace('/', "\\")
                .to_lowercase()
                .trim_end_matches('\\')
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

// Only inspect existence; never inspect user data contents. An inspection error
// must not be interpreted as a new installation.
fn has_existing_state(path: &Path) -> Result<bool, String> {
    for name in [
        "runtime",
        "data",
        ".runtime-staging",
        ".runtime-previous",
        ".neo-node",
        "logs",
    ] {
        match fs::symlink_metadata(path.join(name)) {
            Ok(_) => return Ok(true),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(format!(
                    "无法确认已有安装状态（{}）：{e}；不会自动切换目录",
                    path.display()
                ))
            }
        }
    }
    Ok(false)
}

pub(super) fn select(
    requested: &Path,
    candidates: &[PathBuf],
    pinned: bool,
    validate: impl Fn(&Path) -> Result<(), String>,
    mut probe: impl FnMut(&Path) -> Result<(), String>,
) -> Result<PathBuf, String> {
    // Safety rejection is NOT a write failure and never enables fallback.
    validate(requested)?;
    let existing = pinned || has_existing_state(requested)?;
    let first_error = match probe(requested) {
        Ok(()) => return Ok(requested.to_path_buf()),
        Err(e) => e,
    };
    // A failed revalidation (e.g. a new junction) is not eligible for fallback.
    validate(requested)?;
    if existing {
        return Err(format!("已有安装目录读写检查失败：{first_error}。为保护已有会话，不会自动切换目录；请修复权限或手动迁移。"));
    }
    let mut failures = vec![format!("{}：{first_error}", requested.display())];
    let mut seen = vec![requested.to_path_buf()];
    for path in candidates {
        if seen.iter().any(|p| same_path(p, path)) {
            continue;
        }
        seen.push(path.clone());
        let outcome = validate(path).and_then(|_| {
            if has_existing_state(path)? {
                Err("候选目录已有运行时或数据，拒绝自动接管".into())
            } else {
                probe(path)
            }
        });
        match outcome {
            Ok(()) => return Ok(path.clone()),
            Err(e) => failures.push(format!("{}：{e}", path.display())),
        }
    }
    Err(format!(
        "没有可读写的安全持久目录（不会使用临时目录）。请另选本程序专用目录或修复权限。\n{}",
        failures.join("\n")
    ))
}

/// Exclusive probe directory, exclusive file creation, round trip, rename and
/// deletion. Cleanup touches only our files, never recursively removes a tree.
pub(super) fn probe(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("创建目录 {} 失败：{e}", path.display()))?;
    // Revalidate after creation; do not operate through a newly introduced link.
    super::install_path::validate_install_dir(path)?;
    probe_owned(path)?;
    for name in ["runtime", "data", "logs", ".neo-node"] {
        let child = path.join(name);
        match fs::symlink_metadata(&child) {
            Ok(meta) => {
                #[cfg(windows)]
                let link = {
                    use std::os::windows::fs::MetadataExt;
                    meta.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let link = meta.file_type().is_symlink();
                if link || !meta.is_dir() {
                    return Err(format!("拒绝非普通子目录：{}", child.display()));
                }
                probe_owned(&child)?;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("无法检查子目录 {}：{e}", child.display())),
        }
    }
    Ok(())
}

// Caller validates the install root and rejects child reparse points first.
fn probe_owned(path: &Path) -> Result<(), String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let mut owned = None;
    for _ in 0..16 {
        let dir = path.join(format!(
            ".neo-rw-probe-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::create_dir(&dir) {
            Ok(()) => {
                owned = Some(dir);
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("创建探针目录 {} 失败：{e}", path.display())),
        }
    }
    let dir = owned.ok_or("无法分配独有读写探针目录")?;
    let original = dir.join("write");
    let renamed = dir.join("renamed");
    let outcome = (|| -> io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&original)?;
        file.write_all(b"neo-storage-probe-v1")?;
        file.sync_all()?;
        drop(file);
        let mut bytes = Vec::new();
        fs::File::open(&original)?.read_to_end(&mut bytes)?;
        if bytes != b"neo-storage-probe-v1" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "probe readback differs",
            ));
        }
        fs::rename(&original, &renamed)?;
        fs::remove_file(&renamed)?;
        Ok(())
    })();
    let mut cleanup_errors = Vec::new();
    for file in [&original, &renamed] {
        if let Err(e) = fs::remove_file(file) {
            if e.kind() != io::ErrorKind::NotFound {
                cleanup_errors.push(e.to_string());
            }
        }
    }
    if let Err(e) = fs::remove_dir(&dir) {
        cleanup_errors.push(e.to_string());
    }
    if !cleanup_errors.is_empty() {
        return Err(format!(
            "探针清理失败 {}：{}；读写结果：{:?}",
            dir.display(),
            cleanup_errors.join("；"),
            outcome
        ));
    }
    outcome.map_err(|e| format!("目录 {} 写入/读取/重命名/删除检查失败：{e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let p = std::env::temp_dir().join(format!(
                "neo-storage-test-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn unwritable_falls_back_and_deduplicates() {
        let t = Temp::new();
        let a = t.0.join("a");
        let b = t.0.join("b");
        let mut calls = 0;
        let result = select(
            &a,
            &[a.clone(), b.clone(), b.clone()],
            false,
            |_| Ok(()),
            |p| {
                calls += 1;
                if p == a {
                    Err("access denied".into())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap();
        assert_eq!(result, b);
        assert_eq!(calls, 2);
    }
    #[test]
    fn all_candidates_fail_with_reasons() {
        let t = Temp::new();
        let error = select(
            &t.0.join("a"),
            &[t.0.join("b")],
            false,
            |_| Ok(()),
            |_| Err("disk full".into()),
        )
        .unwrap_err();
        assert!(error.contains("disk full"));
        assert!(error.contains("不会使用临时目录"));
    }
    #[test]
    fn configured_and_existing_data_never_fall_back() {
        let t = Temp::new();
        let a = t.0.join("a");
        for pinned in [true, false] {
            if !pinned {
                fs::create_dir_all(a.join("data")).unwrap();
            }
            let mut calls = 0;
            let err = select(
                &a,
                &[t.0.join("b")],
                pinned,
                |_| Ok(()),
                |_| {
                    calls += 1;
                    Err("denied".into())
                },
            )
            .unwrap_err();
            assert_eq!(calls, 1);
            assert!(err.contains("不会自动切换"));
        }
    }
    #[test]
    fn unsafe_input_never_probed_or_falls_back() {
        let t = Temp::new();
        assert!(select(
            &t.0,
            &[t.0.join("b")],
            false,
            |_| Err("unsafe".into()),
            |_| panic!("must not probe")
        )
        .unwrap_err()
        .contains("unsafe"));
    }
    #[test]
    fn unsafe_or_existing_fallback_is_skipped() {
        let t = Temp::new();
        let a = t.0.join("a");
        let b = t.0.join("b");
        let c = t.0.join("c");
        let d = t.0.join("d");
        fs::create_dir_all(c.join("data")).unwrap();
        let result = select(
            &a,
            &[b.clone(), c.clone(), d.clone()],
            false,
            |p| if p == b { Err("unsafe".into()) } else { Ok(()) },
            |p| {
                assert!(p != b && p != c);
                if p == a {
                    Err("denied".into())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap();
        assert_eq!(result, d);
    }
    #[test]
    fn actual_probe_preserves_existing_files_and_cleans_up() {
        let t = Temp::new();
        let root = t.0.join("new");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("keep.txt"), b"keep").unwrap();
        probe(&root).unwrap();
        assert_eq!(fs::read(root.join("keep.txt")).unwrap(), b"keep");
        assert_eq!(fs::read_dir(root).unwrap().count(), 1);
    }
    #[test]
    fn config_read_only_absence_is_fresh() {
        let t = Temp::new();
        let file = t.0.join("desktop.json");
        assert!(super::super::read_desktop_config_file(&file)
            .unwrap()
            .is_none());
        fs::write(&file, b"broken").unwrap();
        assert!(super::super::read_desktop_config_file(&file).is_err());
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();
        assert!(super::super::read_desktop_config_file(&file).is_err());
    }
    #[test]
    fn actual_probe_checks_managed_child_and_preserves_data() {
        let t = Temp::new();
        let root = t.0.join("root");
        fs::create_dir_all(root.join("data")).unwrap();
        fs::write(root.join("data").join("session"), b"unchanged").unwrap();
        probe(&root).unwrap();
        assert_eq!(fs::read_dir(root.join("data")).unwrap().count(), 1);
        assert_eq!(
            fs::read(root.join("data").join("session")).unwrap(),
            b"unchanged"
        );
    }
    #[test]
    fn candidates_are_persistent_app_specific_and_deduplicated() {
        let t = Temp::new();
        assert_eq!(
            candidates_from([Some(t.0.clone()), Some(t.0.clone()), None]),
            vec![t.0.join("Neo Desktop Data")]
        );
        assert!(candidates_from([None, None, None]).is_empty());
    }
}
