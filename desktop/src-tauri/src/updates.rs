use std::{
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
static CHECKING: AtomicBool = AtomicBool::new(false);
struct Guard;
impl Drop for Guard {
    fn drop(&mut self) {
        CHECKING.store(false, Ordering::Release);
    }
}
fn check(app: &AppHandle) -> Result<String, String> {
    let resource = app.path().resource_dir().map_err(|e| e.to_string())?;
    let root = crate::read_desktop_config(app)
        .ok()
        .map(|c| c.install_dir)
        .unwrap_or_default();
    let mut command = Command::new(resource.join("node/node.exe"));
    // A read-only helper, never invoke host npm or load user Node startup options.
    for (key, _) in std::env::vars_os() {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if ["NODE", "NPM_", "NVM_", "COREPACK_", "VOLTA_"]
            .iter()
            .any(|p| upper.starts_with(p))
        {
            command.env_remove(key);
        }
    }
    command
        .args(["-e", include_str!("check-updates.cjs"), &root])
        .current_dir(resource)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::hide_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动版本检查：{e}"))?;
    let deadline = Instant::now() + Duration::from_secs(18);
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("检查更新超时，请稍后重试。".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "检查失败：{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
#[tauri::command]
pub async fn check_package_updates(app: AppHandle) -> Result<(), String> {
    if CHECKING.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let _guard = Guard;
    let result = tauri::async_runtime::spawn_blocking(move || check(&app))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    let message = match &result {
        Ok(text) => text.clone(),
        Err(error) => error.clone(),
    };
    rfd::AsyncMessageDialog::new()
        .set_title("Core / Web 更新")
        .set_description(message)
        .set_buttons(rfd::MessageButtons::Ok)
        .show()
        .await;
    result.map(|_| ())
}
