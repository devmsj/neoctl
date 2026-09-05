//! Desktop transport adapter. No plugin names, API routes or web business logic.
//! WebView2 owns the transfer (including cookies, redirects and blob URLs).
use std::path::Path;
use tauri::{
    webview::{DownloadEvent, PageLoadEvent},
    Manager, Webview, WebviewWindowBuilder,
};

fn suggested_name(path: &Path) -> String {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("download");
    let clean: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(180)
        .collect();
    let clean = clean.trim_end_matches(['.', ' ']);
    let stem = clean.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|p| {
            stem.strip_prefix(p).map_or(false, |s| {
                matches!(s, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
        });
    if clean.is_empty() || reserved {
        "download".into()
    } else {
        clean.into()
    }
}

fn handle(webview: Webview, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { destination, .. } => {
            // The page supplies only a suggested filename, never the final local path.
            let mut dialog = rfd::FileDialog::new()
                .set_title("保存下载文件")
                .set_file_name(suggested_name(destination));
            if let Ok(folder) = webview.app_handle().path().download_dir() {
                dialog = dialog.set_directory(folder);
            }
            match dialog.save_file() {
                Some(path) if path.is_absolute() => {
                    *destination = path;
                    true
                }
                _ => false,
            }
        }
        DownloadEvent::Finished { path, success, .. } => {
            // Do not log capability URLs, execute the file, or launch a browser.
            let description = if success {
                path.map(|p| format!("已保存到：{}", p.display()))
                    .unwrap_or_else(|| "文件下载完成。".into())
            } else {
                "下载未完成或已取消，请检查链接是否过期及网络状态后重试。".into()
            };
            tauri::async_runtime::spawn(async move {
                rfd::AsyncMessageDialog::new()
                    .set_title(if success {
                        "下载完成"
                    } else {
                        "下载未完成"
                    })
                    .set_description(description)
                    .set_buttons(rfd::MessageButtons::Ok)
                    .show()
                    .await;
            });
            true
        }
        _ => false,
    }
}

fn is_bootstrap_url(url: &tauri::Url) -> bool {
    url.scheme() != "about"
        && url.host_str() != Some("127.0.0.1")
        && url.host_str() != Some("localhost")
}

pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    // Disable automatic creation in config so hooks are attached before any navigation.
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .expect("main window configuration is required");
    WebviewWindowBuilder::from_config(app, config)?
        .on_download(handle)
        .on_page_load(|window, payload| {
            if payload.event() != PageLoadEvent::Finished || !is_bootstrap_url(payload.url()) {
                return;
            }
            if let Ok(mut start_url) = window
                .app_handle()
                .state::<crate::DesktopState>()
                .start_url
                .lock()
            {
                if start_url.is_none() {
                    *start_url = Some(payload.url().clone());
                }
            }
        })
        .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn safe_names() {
        assert_eq!(suggested_name(Path::new("报告.pdf")), "报告.pdf");
        assert_eq!(suggested_name(Path::new("CON.txt")), "download");
        assert_eq!(suggested_name(Path::new("LPT1")), "download");
        assert_eq!(suggested_name(Path::new("file. ")), "file");
        assert_eq!(suggested_name(Path::new("")), "download");
    }
    #[test]
    fn name_is_bounded() {
        assert_eq!(suggested_name(Path::new(&"a".repeat(400))).len(), 180);
    }
}
