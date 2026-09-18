//! Explicit first-install cleanup. A nonempty target is never erased implicitly.
use serde::Serialize;
use std::{fs, path::Path};

#[derive(Serialize)]
pub struct DirectoryState {
    pub path: String,
    pub nonempty: bool,
    pub entries: Vec<String>,
}
pub fn inspect(path: &Path) -> Result<DirectoryState, String> {
    // No special rule for a session path or its parent: user-selected locations
    // have the same treatment as any other location.
    super::install_path::validate_location(path)?;
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries
            .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("无法读取安装位置 {}：{e}", path.display())),
    };
    Ok(DirectoryState {
        path: path.to_string_lossy().into_owned(),
        nonempty: !entries.is_empty(),
        entries,
    })
}

/// Only invoked after the native dialog explicitly lists this exact directory
/// and warns that sessions, settings and workspaces in it will be deleted.
pub fn clear_confirmed(path: &Path) -> Result<(), String> {
    super::install_path::validate_location(path)?;
    let _gate = super::directory_gate::acquire(path)?;
    if !super::runtime_store::plain(path)? {
        return Ok(());
    }
    // Do not partially erase data before discovering an updater is still active.
    let mut leases = Vec::new();
    for name in ["desktop.lock", "update.lock"] {
        let lock = path.join(".neo-updater").join(name);
        if lock.is_file() {
            let file = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&lock)
                .map_err(|e| e.to_string())?;
            file.try_lock()
                .map_err(|e| format!("桌面实例或更新任务仍在使用此目录，未开始清理：{e}"))?;
            leases.push(file);
        }
    }
    // The external gate prevents new leases while lock files are removed.
    drop(leases);
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        remove_entry(&entry.path())?;
    }
    let state = inspect(path)?;
    if state.nonempty {
        return Err(format!(
            "清理尚未完成，仍有内容：{}",
            state.entries.join("、")
        ));
    }
    super::install_storage::probe(path)?;
    Ok(())
}
fn remove_entry(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let link = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let link = metadata.file_type().is_symlink();
    // Remove junction itself; never recurse into its target.
    if metadata.is_dir() && !link {
        for entry in
            fs::read_dir(path).map_err(|e| format!("读取待清理目录 {}：{e}", path.display()))?
        {
            remove_entry(&entry.map_err(|e| e.to_string())?.path())?;
        }
    }
    // Owned files may carry the Windows read-only attribute. Do not change ACLs.
    #[cfg(windows)]
    if !link && metadata.permissions().readonly() {
        let mut permissions = metadata.permissions();
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions)
            .map_err(|e| format!("清除只读属性 {}：{e}", path.display()))?;
    }
    for attempt in 0..5 {
        let result = if metadata.is_dir() {
            fs::remove_dir(path)
        } else {
            fs::remove_file(path)
        };
        match result {
            Ok(())=>return Ok(()),
            Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(()),
            Err(e) if attempt==4=>return Err(format!("清理未完成：无法删除 {}：{e}。请关闭占用此文件的程序后重试；未显示清理成功，也不会开始安装。",path.display())),
            Err(_)=>std::thread::sleep(std::time::Duration::from_millis(150*(attempt+1))),
        }
    }
    unreachable!()
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(super::super::runtime_store::new_id());
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
    fn inspect_preserves_all_existing_data() {
        let t = Temp::new();
        fs::write(t.0.join("session.json"), "keep").unwrap();
        let state = inspect(&t.0).unwrap();
        assert!(state.nonempty);
        assert_eq!(
            fs::read_to_string(t.0.join("session.json")).unwrap(),
            "keep"
        );
    }
    #[test]
    fn confirmed_clear_is_verified_empty_and_writable() {
        let t = Temp::new();
        fs::create_dir(t.0.join("data")).unwrap();
        fs::write(
            t.0.join("data/session.json"),
            "explicitly confirmed fixture",
        )
        .unwrap();
        clear_confirmed(&t.0).unwrap();
        assert!(!inspect(&t.0).unwrap().nonempty);
    }
    #[test]
    fn owned_lock_files_can_be_cleared_after_leases_close() {
        let t = Temp::new();
        let lease = super::super::runtime_store::lock(&t.0, "desktop.lock").unwrap();
        fs::write(t.0.join("keep"), "data").unwrap();
        assert!(clear_confirmed(&t.0).is_err());
        assert!(t.0.join("keep").exists());
        drop(lease);
        clear_confirmed(&t.0).unwrap();
        assert!(!inspect(&t.0).unwrap().nonempty);
    }
    #[cfg(windows)]
    #[test]
    fn confirmed_clear_removes_readonly_files() {
        let t = Temp::new();
        let p = t.0.join("readonly");
        fs::write(&p, "fixture").unwrap();
        let mut permissions = fs::metadata(&p).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&p, permissions).unwrap();
        clear_confirmed(&t.0).unwrap();
        assert!(!inspect(&t.0).unwrap().nonempty);
    }
    #[cfg(windows)]
    #[test]
    fn locked_file_is_never_reported_as_success() {
        use std::os::windows::fs::OpenOptionsExt;
        let t = Temp::new();
        let p = t.0.join("locked");
        fs::write(&p, "keep").unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&p)
            .unwrap();
        assert!(clear_confirmed(&t.0).is_err());
        assert!(p.exists());
        drop(lock);
        clear_confirmed(&t.0).unwrap();
        assert!(!p.exists());
    }
}
