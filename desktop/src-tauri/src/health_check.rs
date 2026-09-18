//! Loopback health response must match the Core loaded from the candidate release.
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    time::{Duration, Instant},
};

pub fn wait(base_url: &str, expected_core: &str, timeout: Duration) -> Result<(), String> {
    let address: SocketAddr = base_url
        .trim_start_matches("http://")
        .parse()
        .map_err(|e| format!("无效健康检查地址：{e}"))?;
    if !address.ip().is_loopback() {
        return Err("健康检查只允许本机地址".into());
    }
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(1)) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
            // HTTP/1.0 + close avoids chunked transfer. Bound untrusted response memory.
            if stream.write_all(b"GET /api/client-info HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_ok() {
                let mut bytes = Vec::new();
                if stream.take(65537).read_to_end(&mut bytes).is_ok() && bytes.len() <= 65536 && matches_response(&bytes, expected_core) { return Ok(()); }
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!("Neo 后台健康检查失败或内核版本不匹配（预期 {expected_core}）；未提交候选版本。请查看 logs。"))
}
fn matches_response(bytes: &[u8], expected_core: &str) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let Some((headers, body)) = text.split_once("\r\n\r\n") else {
        return false;
    };
    let mut status = headers
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace();
    if !matches!(status.next(), Some("HTTP/1.0" | "HTTP/1.1")) || status.next() != Some("200") {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .is_some_and(|v| {
            v["coreVersion"].as_str() == Some(expected_core) && !expected_core.is_empty()
        })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn health_requires_success_and_expected_core() {
        assert!(matches_response(
            b"HTTP/1.1 200 OK\r\n\r\n{\"coreVersion\":\"1.2.3\"}",
            "1.2.3"
        ));
        for text in [
            "HTTP/1.1 200 OK\r\n\r\n<html>loading</html>",
            "HTTP/1.1 200 OK\r\n\r\n{\"coreVersion\":\"0.0.0\"}",
            "HTTP/1.1 500 Error\r\n\r\n{\"coreVersion\":\"1.2.3\"}",
        ] {
            assert!(!matches_response(text.as_bytes(), "1.2.3"));
        }
    }
}
