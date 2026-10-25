//! Frontend-owned window controls. Only the bootstrap and exact local app may invoke them.
use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewWindow};

fn trusted_page(
    current: &tauri::Url,
    runtime: Option<&str>,
    development: Option<&tauri::Url>,
) -> bool {
    if crate::bootstrap_page::is_url(current) { return true; }
    if (current.scheme() == "tauri" && current.host_str() == Some("localhost"))
        || (matches!(current.scheme(), "http" | "https")
            && matches!(current.host_str(), Some("tauri.localhost")))
    {
        return true;
    }
    if current.scheme() != "http" || current.host_str() != Some("127.0.0.1") {
        return false;
    }
    runtime
        .and_then(|url| tauri::Url::parse(url).ok())
        .is_some_and(|url| current.origin() == url.origin())
        || (cfg!(debug_assertions)
            && development.is_some_and(|url| current.origin() == url.origin()))
}

fn authorize(window: &WebviewWindow) -> Result<(), String> {
    let state = window.state::<crate::DesktopState>();
    let runtime = state.runtime_url.lock().map_err(|_| "状态锁错误")?;
    let current = window.url().map_err(|error| error.to_string())?;
    if window.label() != "main"
        || !trusted_page(
            &current,
            runtime.as_ref().map(|(_, url)| url.as_str()),
            window.config().build.dev_url.as_ref(),
        )
    {
        return Err("仅允许当前桌面界面操作窗口".into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum WindowAction {
    Minimize,
    ToggleMaximize,
    Close,
    Drag,
    State,
}

#[tauri::command]
async fn window_action(window: WebviewWindow, action: WindowAction) -> Result<bool, String> {
    authorize(&window)?;
    match action {
        WindowAction::Minimize => window.minimize(),
        WindowAction::ToggleMaximize => {
            if window.is_maximized().map_err(|error| error.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        // Keep the existing tray/exit confirmation and managed-process cleanup.
        WindowAction::Close => window.close(),
        WindowAction::Drag => window.start_dragging(),
        WindowAction::State => Ok(()),
    }
    .map_err(|error| error.to_string())?;
    window.is_maximized().map_err(|error| error.to_string())
}

// Match both erase-background and WebView2's unpainted surface to the page.
// Run off the WebView message loop, just like the window controls above.
#[tauri::command]
async fn sync_surface(window: WebviewWindow, dark: bool, color: [u8; 3]) -> Result<(), String> {
    authorize(&window)?;
    window.set_theme(Some(if dark { tauri::Theme::Dark } else { tauri::Theme::Light }))
        .map_err(|error| error.to_string())?;
    window.set_background_color(Some(tauri::window::Color(color[0], color[1], color[2], 255)))
        .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ApplicationAction {
    StartPage,
    CheckUpdates,
    Uninstall,
}

#[tauri::command]
async fn application_action(
    app: AppHandle,
    window: WebviewWindow,
    action: ApplicationAction,
) -> Result<(), String> {
    authorize(&window)?;
    match action {
        ApplicationAction::StartPage => crate::uninstall::return_start_page(&app),
        ApplicationAction::CheckUpdates => crate::updates::check_package_updates(app).await,
        ApplicationAction::Uninstall => crate::uninstall::uninstall_desktop(app).await,
    }
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("desktop-chrome")
        .js_init_script(include_str!("../../ui/window-chrome.js").to_string())
        .invoke_handler(tauri::generate_handler![window_action, application_action, sync_surface])
        .on_event(|app, event| {
            // Wry handles WM_MOVE. Refresh after DPI transitions and refocus too,
            // without changing focus or resetting an active IME composition.
            #[cfg(windows)]
            if let tauri::RunEvent::WindowEvent { label, event, .. } = event {
                if label == "main" && matches!(event,
                    tauri::WindowEvent::ScaleFactorChanged { .. } | tauri::WindowEvent::Focused(true)) {
                    if let Some(window) = app.get_webview_window(label) {
                        if let Err(error) = window.with_webview(|webview| unsafe {
                            if let Err(error) = webview.controller().NotifyParentWindowPositionChanged() {
                                eprintln!("WebView position refresh failed: {error}");
                            }
                        }) {
                            eprintln!("WebView position dispatch failed: {error}");
                        }
                    }
                }
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chrome_rejects_untrusted_origins_and_accepts_exact_runtime() {
        for value in [
            "https://example.com",
            "http://localhost:5173",
            "http://127.0.0.1:5174",
            "file:///C:/app.html",
            "https://tauri.localhost.evil/",
        ] {
            assert!(
                !trusted_page(&value.parse().unwrap(), Some("http://127.0.0.1:5173"), None),
                "{value}"
            );
        }
        for value in [
            "http://127.0.0.1:5173/chat",
            "http://tauri.localhost/",
            "tauri://localhost/",
        ] {
            assert!(
                trusted_page(&value.parse().unwrap(), Some("http://127.0.0.1:5173"), None),
                "{value}"
            );
        }
    }
}
