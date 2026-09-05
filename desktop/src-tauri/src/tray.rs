use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
static PROMPT_OPEN: AtomicBool = AtomicBool::new(false);
const MINIMIZE: &str = "最小化到托盘";
const EXIT: &str = "直接退出";

#[derive(Debug, PartialEq)]
enum CloseAction {
    Minimize,
    Exit,
    Cancel,
}
fn close_action(result: rfd::MessageDialogResult) -> CloseAction {
    use rfd::MessageDialogResult::*;
    match result {
        Yes => CloseAction::Minimize,
        No => CloseAction::Exit,
        Custom(label) if label == MINIMIZE => CloseAction::Minimize,
        Custom(label) if label == EXIT => CloseAction::Exit,
        _ => CloseAction::Cancel,
    }
}
struct PromptGuard;
impl Drop for PromptGuard {
    fn drop(&mut self) {
        PROMPT_OPEN.store(false, Ordering::Release);
    }
}

fn restore(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
fn exit(app: &AppHandle) {
    if let Some(state) = app.try_state::<crate::DesktopState>() {
        crate::stop_existing_child(&state.child);
    }
    app.exit(0);
}
pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("tray-open", "打开 Neo")
        .separator()
        .text("tray-exit", "退出应用")
        .build()?;
    let mut tray = TrayIconBuilder::with_id("neo-main-tray")
        .tooltip("Neo Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => restore(app),
            "tray-exit" => exit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                restore(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    // One observer for both native surfaces; never changes files or the installed runtime.
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        let mut previous = None;
        loop {
            if handle.get_webview_window("main").is_none() {
                break;
            }
            let active = crate::runtime_control::runtime_status(handle.clone());
            if previous != Some(active) {
                if let Some(base) = handle.default_window_icon() {
                    let mut rgba = base.rgba().to_vec();
                    if active {
                        for pixel in rgba.chunks_exact_mut(4) {
                            // Replace the sky-blue fill only; keep outline, background and alpha.
                            if pixel[2] > 130
                                && pixel[1] > 90
                                && (pixel[2] as i16 - pixel[0] as i16) > 50
                            {
                                pixel[0] = 163;
                                pixel[1] = 230;
                                pixel[2] = 53;
                            }
                        }
                    }
                    let icon = tauri::image::Image::new_owned(rgba, base.width(), base.height());
                    let mut updated = true;
                    if let Some(tray) = handle.tray_by_id("neo-main-tray") {
                        updated &= tray.set_icon(Some(icon.clone())).is_ok();
                        updated &= tray
                            .set_tooltip(Some(if active {
                                "Neo Desktop · 核心和后台运行中"
                            } else {
                                "Neo Desktop · 核心和后台已关闭"
                            }))
                            .is_ok();
                    }
                    if let Some(window) = handle.get_webview_window("main") {
                        updated &= window.set_icon(icon).is_ok();
                    }
                    if updated {
                        previous = Some(active);
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
    Ok(())
}
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        if PROMPT_OPEN.swap(true, Ordering::AcqRel) {
            return;
        }
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            let _guard = PromptGuard;
            let result = rfd::AsyncMessageDialog::new()
                .set_title("关闭 Neo")
                .set_description(
                    "最小化到托盘：保持后台任务运行。\n退出应用：停止后台服务与正在进行的任务。",
                )
                .set_buttons(rfd::MessageButtons::YesNoCancelCustom(
                    MINIMIZE.into(),
                    EXIT.into(),
                    "取消".into(),
                ))
                .show()
                .await;
            match close_action(result) {
                CloseAction::Minimize => {
                    if let Some(window) = app.get_webview_window("main") {
                        if let Err(error) = window.hide() {
                            rfd::AsyncMessageDialog::new()
                                .set_title("无法最小化到托盘")
                                .set_description(error.to_string())
                                .show()
                                .await;
                        }
                    }
                }
                CloseAction::Exit => exit(&app),
                CloseAction::Cancel => {}
            }
        });
    } else if matches!(event, tauri::WindowEvent::Destroyed) {
        if let Some(state) = window.try_state::<crate::DesktopState>() {
            crate::stop_existing_child(&state.child);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rfd::MessageDialogResult::*;
    #[test]
    fn custom_buttons_dispatch() {
        assert_eq!(close_action(Custom(MINIMIZE.into())), CloseAction::Minimize);
        assert_eq!(close_action(Custom(EXIT.into())), CloseAction::Exit);
        assert_eq!(close_action(Custom("取消".into())), CloseAction::Cancel);
    }
    #[test]
    fn standard_windows_results_dispatch() {
        assert_eq!(close_action(Yes), CloseAction::Minimize);
        assert_eq!(close_action(No), CloseAction::Exit);
        assert_eq!(close_action(Cancel), CloseAction::Cancel);
        assert_eq!(close_action(Ok), CloseAction::Cancel);
    }
}
