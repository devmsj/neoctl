//! Generic local-file UX. No web plugin IDs, routes or persistence formats belong here.
use std::path::{Path, PathBuf};
use tauri::{Manager, WebviewWindow};

fn trusted_runtime_origin(current: &tauri::Url, runtime: &str) -> bool {
    tauri::Url::parse(runtime).is_ok_and(|url| {
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && current.origin() == url.origin()
    })
}

pub(crate) fn existing_local_file(path: &Path) -> Result<PathBuf, String> {
    // Reject URLs, relative paths, UNC shares and device namespaces before touching the filesystem.
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if !matches!(path.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_)))
        {
            return Err("只能定位本机磁盘上的文件".into());
        }
    }
    if !path.is_absolute() || path.as_os_str().to_string_lossy().contains('\0') {
        return Err("文件路径无效".into());
    }
    let metadata =
        std::fs::metadata(path).map_err(|_| "原文件已移动、删除或无法访问".to_string())?;
    if !metadata.is_file() {
        return Err("资源不是普通文件".into());
    }
    Ok(path.to_path_buf())
}

pub(crate) fn authorize(window: &WebviewWindow) -> Result<(), String> {
    let runtime = window
        .state::<crate::DesktopState>()
        .runtime_url
        .lock()
        .map_err(|_| "状态锁错误")?
        .clone();
    let current = window.url().map_err(|e| e.to_string())?;
    if window.label() != "main"
        || !runtime.is_some_and(|(_, url)| trusted_runtime_origin(&current, &url))
    {
        return Err("仅允许当前桌面运行时访问本地文件".into());
    }
    Ok(())
}

#[tauri::command]
async fn reveal_file(window: WebviewWindow, path: String) -> Result<(), String> {
    authorize(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let file = existing_local_file(Path::new(&path))?;
        reveal(&file)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn reveal(path: &Path) -> Result<(), String> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::Shell::{SHOpenFolderAndSelectItems, SHParseDisplayName},
    };
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // Shell PIDLs avoid command-line quoting/injection and select the file without executing it.
    unsafe {
        let initialized = CoInitializeEx(ptr::null(), COINIT_APARTMENTTHREADED as u32);
        if initialized < 0 {
            return Err("无法初始化文件管理器".into());
        }
        let mut item = ptr::null_mut();
        let parsed = SHParseDisplayName(
            name.as_ptr(),
            ptr::null_mut(),
            &mut item,
            0,
            ptr::null_mut(),
        );
        let opened = if parsed >= 0 {
            SHOpenFolderAndSelectItems(item, 0, ptr::null(), 0)
        } else {
            parsed
        };
        if !item.is_null() {
            CoTaskMemFree(item.cast());
        }
        CoUninitialize();
        if opened < 0 {
            return Err(format!("无法在文件管理器中显示文件（{opened:#x}）"));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn reveal(_path: &Path) -> Result<(), String> {
    Err("当前平台暂不支持定位本地文件".into())
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("local-resources")
        .setup(|app, _| {
            app.manage(crate::local_file_drop::FileDrops::default());
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                crate::local_file_drop::clear(webview.app_handle());
            }
        })
        .on_event(|app, event| {
            // A WebviewWindow (WindowContent) dispatches native drops as WindowEvent.
            // Do not also subscribe to WebviewEvent and risk duplicate delivery.
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::DragDrop(drop),
                ..
            } = event
            {
                crate::local_file_drop::forward(app, label, drop);
            }
        })
        .invoke_handler(tauri::generate_handler![
            reveal_file,
            crate::local_file_drop::watch_file_drops,
            crate::local_file_drop::unwatch_file_drops,
            crate::local_file_drop::take_file_drop
        ])
        .build()
}

#[cfg(test)]
#[path = "../../tests/rust/local_resources_tests.rs"]
mod tests;
