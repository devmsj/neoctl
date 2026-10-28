//! Native file drops transport references only; never read, upload or copy file contents.
use serde::Serialize;
use std::{collections::BTreeMap, path::PathBuf, sync::Mutex};
use tauri::{ipc::Channel, Manager, WebviewWindow};

#[derive(Default)]
pub(crate) struct FileDrops(Mutex<DropState>);

#[derive(Default)]
struct DropState {
    channel: Option<Channel<serde_json::Value>>,
    next_id: u32,
    pending: BTreeMap<u32, Vec<PathBuf>>,
}

impl DropState {
    fn retain_drop(&mut self, paths: &[PathBuf]) -> Result<u32, String> {
        if paths.len() > 256 {
            return Err("一次最多引用 256 个文件".into());
        }
        self.next_id = self.next_id.wrapping_add(1);
        while self.pending.len() >= 16 {
            self.pending.pop_first();
        }
        let mut unique = Vec::new();
        for path in paths {
            if !unique.contains(path) {
                unique.push(path.clone());
            }
        }
        self.pending.insert(self.next_id, unique);
        Ok(self.next_id)
    }

    fn take(&mut self, id: u32) -> Result<Vec<PathBuf>, String> {
        self.pending
            .remove(&id)
            .ok_or_else(|| "拖拽引用已过期，请重新拖入".into())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileReference {
    kind: &'static str,
    name: String,
    mime_type: &'static str,
    size: u64,
    absolute_path: String,
}

fn image_mime(path: &std::path::Path) -> &'static str {
    use std::io::Read;
    let mut header = [0u8; 1024];
    let n = std::fs::File::open(path).and_then(|mut f| f.read(&mut header)).unwrap_or(0);
    let bytes = &header[..n];
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return "image/png"; }
    if bytes.starts_with(&[255, 216, 255]) { return "image/jpeg"; }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") { return "image/gif"; }
    if n >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" { return "image/webp"; }
    if bytes.starts_with(b"BM") { return "image/bmp"; }
    if String::from_utf8_lossy(bytes).contains("<svg") { return "image/svg+xml"; }
    "application/octet-stream"
}

fn reference(path: &std::path::Path) -> Result<FileReference, String> {
    let file = super::local_resources::existing_local_path(path)?;
    let metadata = std::fs::metadata(&file).map_err(|_| "原文件已移动、删除或无法访问")?;
    Ok(FileReference {
        kind: if metadata.is_dir() { "directory" } else { "file" },
        name: file
            .file_name()
            .unwrap_or(file.as_os_str())
            .to_string_lossy()
            .into_owned(),
        // Only sniff a small header here; the web input pipeline validates/decodes images.
        mime_type: if metadata.is_dir() { "inode/directory" } else { image_mime(&file) },
        size: metadata.len(),
        absolute_path: file.to_str().ok_or("文件路径编码无效")?.to_owned(),
    })
}

#[tauri::command]
pub(crate) async fn watch_file_drops(
    window: WebviewWindow,
    channel: Channel<serde_json::Value>,
) -> Result<(), String> {
    super::local_resources::authorize(&window)?;
    let state = window.state::<FileDrops>();
    let mut state = state.0.lock().map_err(|_| "拖拽状态锁错误")?;
    state.channel = Some(channel);
    state.pending.clear();
    Ok(())
}

#[tauri::command]
pub(crate) async fn unwatch_file_drops(window: WebviewWindow, channel_id: u32) -> Result<(), String> {
    super::local_resources::authorize(&window)?;
    let state = window.state::<FileDrops>();
    let mut state = state.0.lock().map_err(|_| "拖拽状态锁错误")?;
    if state.channel.as_ref().is_some_and(|c| c.id() == channel_id) {
        state.channel = None;
        state.pending.clear();
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn take_file_drop(
    window: WebviewWindow,
    id: u32,
) -> Result<Vec<FileReference>, String> {
    super::local_resources::authorize(&window)?;
    let paths = window
        .state::<FileDrops>()
        .0
        .lock()
        .map_err(|_| "拖拽状态锁错误")?
        .take(id)?;
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|path| reference(path)).collect())
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn clear(app: &tauri::AppHandle) {
    if let Ok(mut state) = app.state::<FileDrops>().0.lock() {
        state.channel = None;
        state.pending.clear();
    }
}

pub(crate) fn forward(app: &tauri::AppHandle, label: &str, event: &tauri::DragDropEvent) {
    if label != "main" {
        return;
    }
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    if super::local_resources::authorize(&window).is_err() {
        clear(app);
        return;
    }
    let drops = app.state::<FileDrops>();
    let Ok(mut state) = drops.0.lock() else {
        return;
    };
    let Some(channel) = state.channel.clone() else {
        return;
    };
    use tauri::DragDropEvent;
    let value = match event {
        DragDropEvent::Enter { position, .. } | DragDropEvent::Over { position } => {
            serde_json::json!({ "type": "over", "position": { "x": position.x, "y": position.y } })
        }
        DragDropEvent::Drop { paths, position } => {
            // Bounded one-shot references. The page cannot supply arbitrary paths to this command.
            let (id, error) = match state.retain_drop(paths) {
                Ok(id) => (Some(id), None),
                Err(error) => (None, Some(error)),
            };
            serde_json::json!({ "type": "drop", "id": id, "error": error, "position": { "x": position.x, "y": position.y } })
        }
        DragDropEvent::Leave => serde_json::json!({ "type": "leave" }),
        _ => return,
    };
    if channel.send(value).is_err() {
        state.channel = None;
        state.pending.clear();
    }
}

#[cfg(test)]
#[path = "../../tests/rust/local_file_drop_tests.rs"]
mod tests;
