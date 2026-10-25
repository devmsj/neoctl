use std::path::PathBuf;
use tauri::{AppHandle, Manager, WebviewWindow};
pub(crate) fn running(app: &AppHandle) -> bool {
    let state = app.state::<crate::DesktopState>();
    let alive = match state.child.lock() {
        Ok(mut slot) => slot
            .as_mut()
            .map(|c| !matches!(c.try_wait(), Ok(Some(_))))
            .unwrap_or(false),
        Err(_) => true, // Unknown is not permission to replace a runtime.
    };
    alive
}
// An explicitly attached development server is not a managed child. Never
// acquire its data lock or expose stop/update actions for that external process.
pub(crate) fn attached_target(app: &AppHandle) -> Option<(String, String)> {
    if !cfg!(debug_assertions) { return None; }
    let frontend = app.config().build.dev_url.as_ref()?;
    let backend = tauri::Url::parse(&std::env::var("NEO_DESKTOP_DEV_BACKEND_URL").ok()?).ok()?;
    if !valid_attach_url(frontend) || !valid_attach_url(&backend) { return None; }
    Some((frontend.origin().ascii_serialization(), backend.origin().ascii_serialization()))
}
fn valid_attach_url(url: &tauri::Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.username().is_empty() && url.password().is_none() && url.port().is_some() && url.path() == "/" && url.query().is_none() && url.fragment().is_none()
}
fn check_attached(app: &AppHandle, backend: &str) -> Result<(), String> {
    let root = PathBuf::from(crate::read_desktop_config(app)?.install_dir);
    let expected = crate::read_runtime_versions(&crate::runtime_store::current(&root)?)?.core_version;
    crate::health_check::wait(backend, &expected, std::time::Duration::from_millis(900))
}
#[tauri::command]
pub async fn runtime_status(app: AppHandle) -> bool {
    if let Some((_, backend)) = attached_target(&app) {
        return tauri::async_runtime::spawn_blocking(move || check_attached(&app, &backend).is_ok()).await.unwrap_or(false);
    }
    running(&app)
}
#[tauri::command]
pub async fn start_backend(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if attached_target(&app).is_some() { return Err("开发服务由外部进程管理".into()); }
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
    if attached_target(&app).is_some() { return Err("不能从调试壳停止外部开发服务".into()); }
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
        crate::stop_existing_child(&state.child)?;
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
pub async fn enter_application(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if let Some((frontend, backend)) = attached_target(&app) {
        let check_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || check_attached(&check_app, &backend)).await.map_err(|e| e.to_string())??;
        return window.navigate(frontend.parse().map_err(|e| format!("{e}"))?).map_err(|e| e.to_string());
    }
    if !running(&app) {
        let root = PathBuf::from(crate::read_desktop_config(&app)?.install_dir);
        let child = app.state::<crate::DesktopState>().child.clone();
        return tauri::async_runtime::spawn_blocking(move || crate::launch_runtime_blocking(&app, &window, child, root, true)).await.map_err(|e| e.to_string())?;
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attached_development_urls_require_explicit_loopback_ports_and_no_credentials() {
        assert!(valid_attach_url(&"http://127.0.0.1:5174/".parse().unwrap()));
        for url in ["https://127.0.0.1:5174/", "http://example.com:5174/", "http://localhost:5174/", "http://127.0.0.1/", "http://user@127.0.0.1:5174/", "http://127.0.0.1:5174/api", "http://127.0.0.1:5174/?token=value"] {
            assert!(!valid_attach_url(&url.parse().unwrap()), "{url}");
        }
    }
}
