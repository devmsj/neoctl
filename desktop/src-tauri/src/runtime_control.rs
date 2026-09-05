use std::path::PathBuf;
use tauri::{AppHandle, Manager, WebviewWindow};
fn running(app: &AppHandle) -> bool {
    let state = app.state::<crate::DesktopState>();
    let alive = state
        .child
        .lock()
        .ok()
        .and_then(|mut c| c.as_mut().map(|c| matches!(c.try_wait(), Ok(None))))
        .unwrap_or(false);
    alive
        && state
            .runtime_url
            .lock()
            .map(|u| u.is_some())
            .unwrap_or(false)
}
#[tauri::command]
pub fn runtime_status(app: AppHandle) -> bool {
    running(&app)
}
#[tauri::command]
pub async fn start_backend(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let root = crate::read_desktop_config(&app)?.install_dir;
    let child = app.state::<crate::DesktopState>().child.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::launch_runtime_blocking(&app, &window, child, PathBuf::from(root), false)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn stop_backend(app: AppHandle) -> Result<(), String> {
    if rfd::AsyncMessageDialog::new()
        .set_title("关闭核心和后台")
        .set_description("正在运行的任务会中断，关闭后不能进入应用。是否继续？")
        .set_buttons(rfd::MessageButtons::OkCancel)
        .show()
        .await
        != rfd::MessageDialogResult::Ok
    {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::DesktopState>();
        let _guard = state.operation.lock().map_err(|_| "操作锁错误")?;
        crate::stop_existing_child(&state.child);
        *state.runtime_url.lock().map_err(|_| "状态锁错误")? = None;
        state
            .manual_start
            .store(true, std::sync::atomic::Ordering::Release);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn enter_application(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let state = app.state::<crate::DesktopState>();
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "后台正在启动或关闭，请稍后重试")?;
    if !running(&app) {
        return Err("请先启动核心和后台".into());
    }
    let url = state
        .runtime_url
        .lock()
        .map_err(|_| "状态锁错误")?
        .as_ref()
        .map(|(_, u)| u.clone())
        .ok_or("请先启动核心和后台")?;
    window
        .navigate(url.parse().map_err(|e| format!("{e}"))?)
        .map_err(|e| e.to_string())
}
