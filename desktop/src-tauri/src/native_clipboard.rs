//! User-initiated clipboard access for the trusted desktop runtime only.
//! No browser permission, background monitoring, disk files or persisted contents.
use tauri::WebviewWindow;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipboardContent {
    text: Option<String>,
    image_png: Option<String>,
}

#[tauri::command]
pub(crate) async fn clipboard_write(window: WebviewWindow, text: String) -> Result<(), String> {
    crate::local_resources::authorize(&window)?;
    tauri::async_runtime::spawn_blocking(move || write(text)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn clipboard_read(window: WebviewWindow) -> Result<ClipboardContent, String> {
    crate::local_resources::authorize(&window)?;
    tauri::async_runtime::spawn_blocking(read).await.map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn retry<T>(mut operation: impl FnMut() -> Result<T, arboard::Error>) -> Result<T, String> {
    for attempt in 0..5 {
        match operation() {
            Ok(value) => return Ok(value),
            Err(arboard::Error::ClipboardOccupied) if attempt < 4 => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(_) => return Err("剪贴板暂时不可用，请重试".into()),
        }
    }
    unreachable!()
}

#[cfg(windows)]
fn write(text: String) -> Result<(), String> {
    retry(|| arboard::Clipboard::new()?.set_text(text.clone()))
}
#[cfg(windows)]
fn png_image(width: usize, height: usize, rgba: &[u8]) -> Result<String, String> {
    use base64::Engine;
    let width = u32::try_from(width).map_err(|_| "剪贴板图片尺寸无效")?;
    let height = u32::try_from(height).map_err(|_| "剪贴板图片尺寸无效")?;
    let expected = (width as usize).checked_mul(height as usize).and_then(|n| n.checked_mul(4));
    if width == 0 || height == 0 || expected != Some(rgba.len()) { return Err("剪贴板图片数据无效".into()); }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|_| "剪贴板图片无法编码")?;
        writer.write_image_data(rgba).map_err(|_| "剪贴板图片无法编码")?;
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}
#[cfg(windows)]
fn read() -> Result<ClipboardContent, String> {
    let (text, image) = retry(|| {
        let mut clipboard = arboard::Clipboard::new()?;
        let text = match clipboard.get_text() { Ok(text) => Some(text), Err(arboard::Error::ContentNotAvailable) => None, Err(e) => return Err(e) };
        let image = match clipboard.get_image() { Ok(image) => Some(image), Err(arboard::Error::ContentNotAvailable) => None, Err(e) => return Err(e) };
        Ok((text, image))
    })?;
    let image_png = image.map(|image| png_image(image.width, image.height, &image.bytes)).transpose()?;
    Ok(ClipboardContent { text, image_png })
}
#[cfg(not(windows))]
fn write(_: String) -> Result<(), String> { Err("当前桌面平台不支持原生剪贴板".into()) }
#[cfg(not(windows))]
fn read() -> Result<ClipboardContent, String> { Err("当前桌面平台不支持原生剪贴板".into()) }

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn native_pixels_are_encoded_as_real_png_and_invalid_buffers_rejected() {
        use base64::Engine;
        let encoded = png_image(2, 1, &[255, 0, 0, 255, 0, 255, 0, 128]).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut reader = decoder.read_info().unwrap();
        assert_eq!((reader.info().width, reader.info().height), (2, 1));
        let mut output = vec![0; reader.output_buffer_size()];
        reader.next_frame(&mut output).unwrap();
        assert_eq!(output, [255, 0, 0, 255, 0, 255, 0, 128]);
        assert!(png_image(0, 1, &[]).is_err());
        assert!(png_image(2, 1, &[0; 4]).is_err());
        assert!(png_image(usize::MAX, 2, &[]).is_err());
    }
}
