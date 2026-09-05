//! Desktop-only uninstall entry point. Never removes runtime/user data itself.
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{
    menu::{MenuBuilder, SubmenuBuilder},
    AppHandle, Manager,
};

const MENU_ID: &str = "uninstall-desktop";
static UNINSTALL_ACTIVE: AtomicBool = AtomicBool::new(false);

struct UninstallGuard;
impl Drop for UninstallGuard {
    fn drop(&mut self) {
        UNINSTALL_ACTIVE.store(false, Ordering::Release);
    }
}

/// Only accept the installed executable's sibling; never search PATH or accept
/// a caller-supplied executable/argument. Kept separate for filesystem tests.
fn uninstaller_next_to(executable: &Path) -> Result<PathBuf, String> {
    if !executable.is_absolute() {
        return Err("无法定位卸载器：当前程序路径不是绝对路径。".into());
    }
    let directory = executable.parent().ok_or("无法定位当前程序所在目录。")?;
    let uninstaller = directory.join("uninstall.exe");
    if !uninstaller.is_file() {
        return Err(format!(
            "未找到 Neo Desktop 卸载器：{}。开发版或未通过安装包安装的版本不支持应用内卸载；程序和数据均未更改。",
            uninstaller.display()
        ));
    }
    Ok(uninstaller)
}

fn confirm_and_uninstall(app: &AppHandle) -> Result<(), String> {
    if UNINSTALL_ACTIVE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(());
    }
    let _guard = UninstallGuard;
    let confirmed = rfd::MessageDialog::new()
        .set_title("卸载 Neo Desktop")
        .set_description("仅卸载 Neo Desktop 程序，保留数据目录、工作区、配置和日志，不会更改系统的 npm / nvm。\n\n继续后将打开官方卸载向导，并停止本应用托管的服务、退出当前窗口。您仍可在卸载向导中取消卸载；取消后可重新启动 Neo Desktop。\n\n是否继续？")
        .set_level(rfd::MessageLevel::Warning)
        .set_buttons(rfd::MessageButtons::OkCancel)
        .show();
    if confirmed != rfd::MessageDialogResult::Ok {
        return Ok(());
    }

    let executable =
        std::env::current_exe().map_err(|error| format!("无法定位当前程序：{error}"))?;
    let uninstaller = uninstaller_next_to(&executable)?;
    // Launch the official interactive NSIS uninstaller, without /S or any
    // deletion flags. Do not kill the runtime or exit before spawn succeeds.
    let _uninstaller = Command::new(&uninstaller)
        .current_dir(uninstaller.parent().ok_or("无法定位卸载器目录。")?)
        .spawn()
        .map_err(|error| {
            format!("无法启动 Neo Desktop 卸载器：{error}。程序仍在运行，数据未更改。")
        })?;

    if let Some(state) = app.try_state::<crate::DesktopState>() {
        crate::stop_existing_child(&state.child);
    }
    app.exit(0);
    Ok(())
}

/// Shared by the bootstrap UI and the native menu (also available after the
/// webview navigates to the local web app). Native errors remain visible even
/// when no frontend invoke/error handler is present.
#[tauri::command]
pub async fn uninstall_desktop(app: AppHandle) -> Result<(), String> {
    let result = tauri::async_runtime::spawn_blocking(move || confirm_and_uninstall(&app))
        .await
        .map_err(|error| format!("卸载任务异常结束：{error}"))
        .and_then(|result| result);
    if let Err(error) = &result {
        rfd::AsyncMessageDialog::new()
            .set_title("无法卸载 Neo Desktop")
            .set_description(error)
            .set_level(rfd::MessageLevel::Error)
            .set_buttons(rfd::MessageButtons::Ok)
            .show()
            .await;
    }
    result
}

pub fn setup_menu(app: &mut tauri::App) -> tauri::Result<()> {
    let desktop_menu = SubmenuBuilder::new(app, "应用")
        .text("return-start-page", "返回启动页")
        .separator()
        .text("check-package-updates", "检查核心与 Web 更新…")
        .separator()
        .text(MENU_ID, "卸载 Neo Desktop…")
        .build()?;
    let menu = MenuBuilder::new(app).item(&desktop_menu).build()?;
    app.set_menu(menu)?;
    Ok(())
}

pub fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    if event.id().as_ref() == "return-start-page" {
        let state = app.state::<crate::DesktopState>();
        state.manual_start.store(true, Ordering::Release);
        let url = state.start_url.lock().ok().and_then(|u| u.clone());
        if let (Some(window), Some(url)) = (app.get_webview_window("main"), url) {
            if let Err(error) = window.navigate(url) {
                rfd::MessageDialog::new()
                    .set_title("无法返回启动页")
                    .set_description(error.to_string())
                    .show();
            }
        }
    }
    if event.id().as_ref() == "check-package-updates" {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::updates::check_package_updates(app).await;
        });
    }
    if event.id().as_ref() == MENU_ID {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            // uninstall_desktop already displays native errors.
            let _ = uninstall_desktop(app).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::atomic::AtomicU64};

    static NEXT_TEST: AtomicU64 = AtomicU64::new(0);
    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "neo-uninstall-test-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_TEST.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&directory).unwrap();
            Self(directory)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn locates_only_sibling_even_with_spaces_and_unicode() {
        let root = TestDirectory::new();
        let install = root.0.join("Neo Desktop 中文");
        fs::create_dir(&install).unwrap();
        let expected = install.join("uninstall.exe");
        fs::write(&expected, b"test fixture, never executed").unwrap();
        assert_eq!(
            uninstaller_next_to(&install.join("Neo Desktop.exe")).unwrap(),
            expected
        );
    }

    #[test]
    fn missing_sibling_reports_development_build_without_searching_parent() {
        let root = TestDirectory::new();
        fs::write(root.0.join("uninstall.exe"), b"not a sibling").unwrap();
        let nested = root.0.join("debug");
        fs::create_dir(&nested).unwrap();
        let error = uninstaller_next_to(&nested.join("neo.exe")).unwrap_err();
        assert!(error.contains("开发版"));
        assert!(error.contains("未找到"));
    }

    #[test]
    fn directory_is_not_an_uninstaller() {
        let root = TestDirectory::new();
        fs::create_dir(root.0.join("uninstall.exe")).unwrap();
        assert!(uninstaller_next_to(&root.0.join("neo.exe")).is_err());
    }

    #[test]
    fn relative_executable_path_is_rejected() {
        assert!(uninstaller_next_to(Path::new("neo.exe"))
            .unwrap_err()
            .contains("绝对路径"));
    }
}
