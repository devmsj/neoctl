//! Short-lived cross-process gate for acquiring persistent leases or clearing a root.
//! Lives outside the installation tree, so deleting lock files cannot split ownership.
use std::path::Path;

#[cfg(windows)]
pub struct DirectoryGate(windows_sys::Win32::Foundation::HANDLE);
#[cfg(not(windows))]
pub struct DirectoryGate;

pub fn acquire(root: &Path) -> Result<DirectoryGate, String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::{Foundation::*, System::Threading::*};
        let path = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let key = path
            .to_string_lossy()
            .replace('/', "\\")
            .trim_start_matches("\\\\?\\")
            .trim_end_matches('\\')
            .to_lowercase();
        // Stable across processes/builds; this is an exclusion key, not a security token.
        let hash = key.as_bytes().iter().fold(0xcbf29ce484222325u64, |h, b| {
            (h ^ *b as u64).wrapping_mul(0x100000001b3)
        });
        let name: Vec<u16> = format!("Local\\NeoDesktopDirectory-{hash:016x}")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let status = unsafe { WaitForSingleObject(handle, 5000) };
        if status != WAIT_OBJECT_0 && status != WAIT_ABANDONED {
            unsafe {
                CloseHandle(handle);
            }
            return Err("此目录正在初始化或清理，请稍后重试；未开始操作".into());
        }
        Ok(DirectoryGate(handle))
    }
    #[cfg(not(windows))]
    {
        let _ = root;
        Err("此桌面安装器仅支持 Windows 目录锁".into())
    }
}

#[cfg(windows)]
impl Drop for DirectoryGate {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::System::Threading::ReleaseMutex(self.0);
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
