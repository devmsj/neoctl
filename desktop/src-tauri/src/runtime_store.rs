//! Versioned runtime storage. Pointer commit precedes garbage collection; user data is never garbage.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
const OWNER: &str = "neo-desktop-releases-v1";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Transaction {
    pub candidate: String,
    pub previous: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Pointer {
    schema: u8,
    release: String,
}

pub fn plain(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("无法检查 {}：{e}", path.display())),
        Ok(m) => {
            #[cfg(windows)]
            let link = {
                use std::os::windows::fs::MetadataExt;
                m.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let link = m.file_type().is_symlink();
            if link {
                return Err(format!("拒绝链接或重解析点：{}", path.display()));
            }
            Ok(true)
        }
    }
}
pub fn id_valid(id: &str) -> bool {
    id.starts_with("r-")
        && id.len() < 100
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
pub fn release(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !id_valid(id) {
        return Err("无效的运行时版本目录标识".into());
    }
    Ok(root.join("releases").join(id))
}
pub fn initialize(root: &Path) -> Result<(), String> {
    for name in [".neo-updater", "releases"] {
        let p = root.join(name);
        if plain(&p)? {
            if p.is_dir()
                && fs::read_dir(&p)
                    .map_err(|e| e.to_string())?
                    .next()
                    .is_none()
            {
                fs::write(p.join(".neo-owned"), OWNER).map_err(|e| e.to_string())?;
            }
            if !p.is_dir()
                || !plain(&p.join(".neo-owned"))?
                || fs::read_to_string(p.join(".neo-owned")).map_err(|e| e.to_string())? != OWNER
            {
                return Err(format!("拒绝接管未知目录：{}", p.display()));
            }
        } else {
            fs::create_dir_all(&p).map_err(|e| e.to_string())?;
            fs::write(p.join(".neo-owned"), OWNER).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
pub fn validate(root: &Path) -> Result<(), String> {
    for name in [".neo-updater", "releases"] {
        let p = root.join(name);
        if plain(&p)? {
            // An empty directory can be left by interrupted initialization.
            if p.is_dir()
                && fs::read_dir(&p)
                    .map_err(|e| e.to_string())?
                    .next()
                    .is_none()
            {
                continue;
            }
            if !p.is_dir()
                || !plain(&p.join(".neo-owned"))?
                || fs::read_to_string(p.join(".neo-owned")).map_err(|e| e.to_string())? != OWNER
            {
                return Err(format!("未知更新目录：{}", p.display()));
            }
            super::install_path::reject_tree_links(&p)?;
        }
    }
    Ok(())
}
pub fn lock(root: &Path, name: &str) -> Result<File, String> {
    let _gate = super::directory_gate::acquire(root)?;
    initialize(root)?;
    let p = root.join(".neo-updater").join(name);
    plain(&p)?;
    let f = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&p)
        .map_err(|e| format!("无法打开锁 {}：{e}", p.display()))?;
    f.try_lock().map_err(|e| {
        format!(
            "该数据目录正在被其他桌面实例或更新任务使用（{}）：{e}",
            p.display()
        )
    })?;
    Ok(f)
}
pub fn atomic_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    plain(path)?;
    let tmp = path.with_extension(format!("tmp-{}-{}", std::process::id(), stamp()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let result = (|| {
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            };
            let from: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
            let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe {
                MoveFileExW(
                    from.as_ptr(),
                    to.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                return Err(format!(
                    "提交 {} 失败：{}",
                    path.display(),
                    std::io::Error::last_os_error()
                ));
            }
        }
        #[cfg(not(windows))]
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}
fn stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}
pub fn new_id() -> String {
    format!("r-{}-{}", stamp(), std::process::id())
}
fn meta(root: &Path, name: &str) -> PathBuf {
    root.join(".neo-updater").join(name)
}
pub fn current_id(root: &Path) -> Result<Option<String>, String> {
    let p = meta(root, "current.json");
    if !plain(&p)? {
        return Ok(None);
    }
    let v: Pointer = serde_json::from_slice(&fs::read(&p).map_err(|e| e.to_string())?)
        .map_err(|e| format!("当前版本记录损坏：{e}"))?;
    if v.schema != 1 || !id_valid(&v.release) {
        return Err("当前版本记录无效".into());
    }
    Ok(Some(v.release))
}
pub fn current(root: &Path) -> Result<PathBuf, String> {
    match current_id(root)? {
        Some(id) => release(root, &id),
        None => Ok(root.join("runtime")),
    }
}
pub fn transaction(root: &Path) -> Result<Option<Transaction>, String> {
    let p = meta(root, "transaction.json");
    if !plain(&p)? {
        return Ok(None);
    }
    let tx: Transaction = serde_json::from_slice(&fs::read(&p).map_err(|e| e.to_string())?)
        .map_err(|e| format!("更新事务损坏：{e}"))?;
    if !id_valid(&tx.candidate) || tx.previous.as_deref().is_some_and(|id| !id_valid(id)) {
        return Err("更新事务目录无效".into());
    }
    Ok(Some(tx))
}
pub fn begin(root: &Path) -> Result<Transaction, String> {
    let tx = Transaction {
        candidate: new_id(),
        previous: current_id(root)?,
    };
    atomic_json(&meta(root, "transaction.json"), &tx)?;
    Ok(tx)
}
pub fn commit(root: &Path, tx: &Transaction) -> Result<(), String> {
    let p = release(root, &tx.candidate)?;
    if !complete(&p) {
        return Err("候选运行时不完整，拒绝提交".into());
    }
    atomic_json(
        &meta(root, "current.json"),
        &Pointer {
            schema: 1,
            release: tx.candidate.clone(),
        },
    )
}
pub fn complete(p: &Path) -> bool {
    p.join("node/node.exe").is_file()
        && p.join("node_modules/neoctl-web/server.mjs").is_file()
        && p.join("neo-desktop-runtime.json").is_file()
}

/// Keep ownership markers until every other entry is gone. Never follow links.
pub fn remove_owned(path: &Path) -> Result<(), String> {
    if !plain(path)? {
        return Ok(());
    }
    super::install_path::reject_tree_links(path)?;
    // Recovery for a crash between mkdir/marker creation or marker removal/rmdir.
    // Empty directories contain no user files to take ownership of.
    if fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .next()
        .is_none()
    {
        return fs::remove_dir(path).map_err(|e| e.to_string());
    }
    let marker = path.join("package.json");
    let bytes = fs::read(&marker)
        .map_err(|e| format!("无法确认待清理目录所有权 {}：{e}", path.display()))?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if value["name"] != "neoctl-desktop-runtime" {
        return Err(format!("拒绝清理未知目录 {}", path.display()));
    }
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name() == "package.json" {
            continue;
        }
        let p = entry.path();
        let mut error = None;
        for attempt in 0..4 {
            let result = if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                fs::remove_dir_all(&p)
            } else {
                fs::remove_file(&p)
            };
            match result {
                Ok(()) => {
                    error = None;
                    break;
                }
                Err(e) => {
                    error = Some(e);
                    std::thread::sleep(std::time::Duration::from_millis(100 * (attempt + 1)));
                }
            }
        }
        if let Some(e) = error {
            return Err(format!(
                "无法删除旧版本文件 {}：{e}；请关闭使用此版本的开发服务/终端后重试清理",
                p.display()
            ));
        }
    }
    fs::remove_file(&marker).map_err(|e| e.to_string())?;
    if let Err(e) = fs::remove_dir(path) {
        let _ = fs::write(&marker, bytes);
        return Err(format!("无法删除旧版本目录 {}：{e}", path.display()));
    }
    Ok(())
}
/// Delete all non-current releases, including interrupted downloads; no historical retention.
/// Caller holds update.lock and ensures no candidate is being health-checked.
pub fn cleanup(root: &Path) -> Result<Vec<String>, String> {
    let active = current_id(root)?;
    if active.is_some() && !complete(&current(root)?) {
        return Err("当前版本不完整，未删除其他版本；请修复当前版本记录后重试".into());
    }
    let mut warnings = vec![];
    for entry in fs::read_dir(root.join("releases")).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".neo-owned" || active.as_deref() == Some(&name) {
            continue;
        }
        if !id_valid(&name) {
            return Err(format!("未知版本目录 {}，拒绝清理", entry.path().display()));
        }
        if let Err(e) = remove_owned(&entry.path()) {
            warnings.push(e);
        }
    }
    // Legacy runtime remains the rollback version until the first pointer commit.
    if active.is_some() {
        for name in ["runtime", ".runtime-previous", ".runtime-staging"] {
            if let Err(e) = remove_owned(&root.join(name)) {
                warnings.push(e);
            }
        }
    }
    // Retain the transaction until garbage collection finishes; restart retries it.
    if warnings.is_empty() {
        let p = meta(root, "transaction.json");
        if plain(&p)? {
            fs::remove_file(p).map_err(|e| e.to_string())?;
        }
    }
    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(new_id());
            fs::create_dir(&p).unwrap();
            initialize(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture(p: &Path) {
        fs::create_dir_all(p.join("node")).unwrap();
        fs::create_dir_all(p.join("node_modules/neoctl-web")).unwrap();
        fs::write(
            p.join("package.json"),
            r#"{"name":"neoctl-desktop-runtime"}"#,
        )
        .unwrap();
        fs::write(p.join("node/node.exe"), "node").unwrap();
        fs::write(p.join("node_modules/neoctl-web/server.mjs"), "server").unwrap();
        fs::write(p.join("neo-desktop-runtime.json"), "{}").unwrap();
    }
    #[test]
    fn commit_then_cleanup_deletes_legacy_and_old_releases_but_not_data() {
        let t = Temp::new();
        fixture(&t.0.join("runtime"));
        fs::create_dir(t.0.join("data")).unwrap();
        fs::write(t.0.join("data/keep"), "session").unwrap();
        let tx = begin(&t.0).unwrap();
        fixture(&release(&t.0, &tx.candidate).unwrap());
        commit(&t.0, &tx).unwrap();
        assert!(cleanup(&t.0).unwrap().is_empty());
        assert!(!t.0.join("runtime").exists());
        assert_eq!(
            fs::read_to_string(t.0.join("data/keep")).unwrap(),
            "session"
        );
        assert!(complete(&current(&t.0).unwrap()));
    }
    #[test]
    fn interrupted_prepare_keeps_previous_and_deletes_candidate() {
        let t = Temp::new();
        fixture(&t.0.join("runtime"));
        let tx = begin(&t.0).unwrap();
        fixture(&release(&t.0, &tx.candidate).unwrap());
        cleanup(&t.0).unwrap();
        assert!(complete(&t.0.join("runtime")));
        assert!(!release(&t.0, &tx.candidate).unwrap().exists());
    }
    #[test]
    fn interrupted_empty_directories_are_recoverable() {
        let t = Temp::new();
        fs::remove_file(t.0.join("releases/.neo-owned")).unwrap();
        validate(&t.0).unwrap();
        initialize(&t.0).unwrap();
        let tx = begin(&t.0).unwrap();
        let candidate = release(&t.0, &tx.candidate).unwrap();
        fs::create_dir(&candidate).unwrap();
        assert!(cleanup(&t.0).unwrap().is_empty());
        assert!(!candidate.exists());
    }
    #[test]
    fn unknown_nonempty_release_is_not_deleted() {
        let t = Temp::new();
        let p = release(&t.0, "r-unknown").unwrap();
        fs::create_dir(&p).unwrap();
        fs::write(p.join("user.txt"), "keep").unwrap();
        assert!(!cleanup(&t.0).unwrap().is_empty());
        assert!(p.join("user.txt").exists());
    }
    #[test]
    fn incomplete_candidate_cannot_commit() {
        let t = Temp::new();
        let tx = begin(&t.0).unwrap();
        assert!(commit(&t.0, &tx).is_err());
        assert!(current_id(&t.0).unwrap().is_none());
    }
    #[test]
    fn pointer_rejects_traversal_and_corruption() {
        let t = Temp::new();
        assert!(release(&t.0, "../data").is_err());
        fs::write(meta(&t.0, "current.json"), "broken").unwrap();
        assert!(current(&t.0).is_err());
    }
    #[test]
    fn cross_instance_lock_is_exclusive_and_released_on_drop() {
        let t = Temp::new();
        let a = lock(&t.0, "update.lock").unwrap();
        assert!(lock(&t.0, "update.lock").is_err());
        drop(a);
        assert!(lock(&t.0, "update.lock").is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn locked_old_file_preserves_marker_and_retries_cleanup() {
        use std::os::windows::fs::OpenOptionsExt;
        let t = Temp::new();
        fixture(&t.0.join("runtime"));
        let hold = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(t.0.join("runtime/node/node.exe"))
            .unwrap();
        let tx = begin(&t.0).unwrap();
        fixture(&release(&t.0, &tx.candidate).unwrap());
        commit(&t.0, &tx).unwrap();
        assert!(!cleanup(&t.0).unwrap().is_empty());
        assert!(t.0.join("runtime/package.json").exists());
        assert!(complete(&current(&t.0).unwrap()));
        drop(hold);
        assert!(cleanup(&t.0).unwrap().is_empty());
        assert!(!t.0.join("runtime").exists());
    }
}
