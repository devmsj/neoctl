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
    // WebView URL reads dispatch to the UI thread. Never retain the runtime
    // mutex across that dispatch: UI-side IPC may need the same state lock.
    let runtime = {
        let guard = state.runtime_url.lock().map_err(|_| "状态锁错误")?;
        guard.clone()
    };
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
    TogglePin,
    PinState,
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
        // Pin actions return the actual native topmost state, not maximized state.
        WindowAction::TogglePin => {
            let pinned = window.is_always_on_top().map_err(|error| error.to_string())?;
            window.set_always_on_top(!pinned).map_err(|error| error.to_string())?;
            return window.is_always_on_top().map_err(|error| error.to_string());
        }
        WindowAction::PinState => return window.is_always_on_top().map_err(|error| error.to_string()),
        // Keep the existing tray/exit confirmation and managed-process cleanup.
        WindowAction::Close => window.close(),
        WindowAction::Drag => window.start_dragging(),
        WindowAction::State => Ok(()),
    }
    .map_err(|error| error.to_string())?;
    window.is_maximized().map_err(|error| error.to_string())
}

// Read Windows app preference independently of the WebView profile's forced theme.
#[tauri::command]
async fn system_theme(window: WebviewWindow) -> Result<bool, String> {
    authorize(&window)?;
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
        let key: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0".encode_utf16().collect();
        let name: Vec<u16> = "AppsUseLightTheme\0".encode_utf16().collect();
        let mut light: u32 = 1;
        let mut size: u32 = 4;
        let status = RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), &mut light as *mut _ as _, &mut size);
        if status == 0 { return Ok(light == 0); }
        if status == 2 { return Ok(false); }
        return Err(format!("Windows theme read failed: {status}"));
    }
    #[cfg(not(windows))]
    Ok(matches!(window.theme(), Ok(tauri::Theme::Dark)))
}

// Match both erase-background and WebView2's unpainted surface to the page.
// Run off the WebView message loop, just like the window controls above.
#[tauri::command]
async fn sync_surface(window: WebviewWindow, dark: bool, color: [u8; 3], transparency: Option<u8>, frost: Option<u8>, theme_mode: Option<String>) -> Result<bool, String> {
    authorize(&window)?;
    // A fixed WebView2 color scheme also overrides prefers-color-scheme.
    // Clear that override in system mode so the page observes Windows again.
    let theme = match theme_mode.as_deref() {
        Some("system") => None,
        _ => Some(if dark { tauri::Theme::Dark } else { tauri::Theme::Light }),
    };
    window.set_theme(theme)
        .map_err(|error| error.to_string())?;
    let transparency = transparency.unwrap_or(0);
    let frost = frost.unwrap_or(0);
    if transparency > 100 || frost > 2 { return Err("窗口材质参数无效".into()); }
    let transparent = transparency > 0 && cfg!(windows);
    #[cfg(windows)]
    if let Err(error) = material::apply(&window, transparent, frost, color) {
        let _ = window.set_background_color(Some(tauri::window::Color(color[0], color[1], color[2], 255)));
        return Err(error);
    }
    // WebView2 only accepts alpha 0 or 255. Tint strength belongs to the page's
    // single canvas, never to the whole native window (text must stay opaque).
    let webview: &tauri::Webview = window.as_ref();
    // DWM consumes premultiplied pixels. Removing the erase brush leaves stale
    // RGB (the initial #111418) with zero alpha: it ADDS that color to everything
    // behind the window. Clear native RGB to black and WebView RGBA to zero.
    let surface = if transparent { tauri::window::Color(0, 0, 0, 0) }
        else { tauri::window::Color(color[0], color[1], color[2], 255) };
    webview.window().set_background_color(Some(surface))
        .map_err(|error| error.to_string())?;
    webview.set_background_color(Some(surface))
        .map_err(|error| error.to_string())?;
    Ok(transparent)
}

#[cfg(windows)]
mod material {
    use std::{ffi::c_void, mem::size_of};
    use tauri::WebviewWindow;
    use windows_sys::{core::BOOL, Win32::{Foundation::HWND, Graphics::Dwm::DwmSetWindowAttribute, System::LibraryLoader::{GetModuleHandleA, GetProcAddress}}};
    #[repr(C)]
    struct Accent { state: u32, flags: u32, color: u32, animation: u32 }
    #[repr(C)]
    struct Attribute { kind: u32, data: *mut c_void, size: usize }
    // Accent Acrylic stays translucent when inactive. DWMSBT_TRANSIENTWINDOW
    // intentionally falls back to a solid brush on deactivation. Never use
    // legacy BLURBEHIND or fake activation/focus to keep the material alive.
    pub fn apply(window: &WebviewWindow, enabled: bool, frost: u8, color: [u8; 3]) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as HWND;
        unsafe {
            let module = GetModuleHandleA(b"user32.dll\0".as_ptr());
            let Some(address) = GetProcAddress(module, b"SetWindowCompositionAttribute\0".as_ptr()) else {
                return if enabled { Err("系统不支持窗口透明".into()) } else { Ok(()) };
            };
            let apply: unsafe extern "system" fn(HWND, *mut Attribute) -> BOOL = std::mem::transmute(address);
            let mut accent = Accent {
                // ACCENT_DISABLED removes the transparent composition surface and
                // exposes an opaque/black backing. Clear glass requires
                // ACCENT_ENABLE_TRANSPARENTGRADIENT (2), not disabled (0).
                state: if !enabled { 0 } else if frost > 0 { 4 } else { 2 },
                flags: 2,
                // Acrylic requires nonzero alpha; CSS owns the visible theme tint.
                color: if enabled && frost > 0 {
                    (1 << 24) | ((color[2] as u32) << 16) | ((color[1] as u32) << 8) | color[0] as u32
                } else { 0 },
                animation: 0,
            };
            let mut data = Attribute { kind: 19, data: &mut accent as *mut _ as *mut c_void, size: size_of::<Accent>() };
            // Always remove any old activation-sensitive DWM backdrop first.
            // Unsupported DWM attributes are harmless on older Windows builds.
            let none: u32 = 1;
            let _ = DwmSetWindowAttribute(hwnd, 38, &none as *const _ as _, 4);
            if apply(hwnd, &mut data) == 0 { return Err("无法应用窗口材质，已恢复实色背景".into()); }

        }
        Ok(())
    }
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
        .js_init_script(format!("{}\n{}", include_str!("../../../web/shared/theme-tooltip.js"), include_str!("../../ui/window-chrome.js")))
        .invoke_handler(tauri::generate_handler![window_action, application_action, sync_surface, system_theme])
        .on_event(|app, event| {
            // Wry handles WM_MOVE. Refresh after DPI transitions and refocus too,
            // without changing focus or resetting an active IME composition.
            #[cfg(windows)]
            if let tauri::RunEvent::WindowEvent { label, event, .. } = event {
                if label == "main" && matches!(event, tauri::WindowEvent::ThemeChanged(_)) {
                    if let Some(window) = app.get_webview_window(label) {
                        let _ = window.eval("window.dispatchEvent(new Event('neo:system-theme-changed'))");
                    }
                }
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
