//! The launcher is always embedded, even when devUrl points at the workbench.
use tauri::http::{Request, Response};

pub fn url() -> tauri::Url {
    if cfg!(windows) {
        "http://neo-start.localhost/index.html"
    } else {
        "neo-start://localhost/index.html"
    }.parse().expect("valid embedded launcher URL")
}

pub fn is_url(value: &tauri::Url) -> bool {
    value.origin() == url().origin()
}

pub fn respond(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let asset = match request.uri().path() {
        "/" | "/index.html" => Some(("text/html; charset=utf-8", include_bytes!("../../ui/index.html").as_slice())),
        "/styles.css" => Some(("text/css; charset=utf-8", include_bytes!("../../ui/styles.css").as_slice())),
        "/app.js" => Some(("text/javascript; charset=utf-8", include_bytes!("../../ui/app.js").as_slice())),
        _ => None,
    };
    let (status, mime, body) = match asset {
        Some((mime, bytes)) => (200, mime, bytes.to_vec()),
        None => (404, "text/plain; charset=utf-8", b"Not found".to_vec()),
    };
    Response::builder().status(status)
        .header("Content-Type", mime)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        .body(body).expect("valid launcher response")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launcher_embeds_html_and_each_referenced_asset_without_dev_server() {
        for (path, mime, marker) in [
            ("/index.html", "text/html", "id=\"readyView\""),
            ("/styles.css", "text/css", ".shell"),
            ("/app.js", "text/javascript", "bootstrap_state"),
        ] {
            let response = respond(Request::builder().uri(path).body(vec![]).unwrap());
            assert_eq!(response.status(), 200);
            assert!(response.headers()["content-type"].to_str().unwrap().starts_with(mime));
            assert!(std::str::from_utf8(response.body()).unwrap().contains(marker));
        }
        for path in ["/missing.js", "/../Cargo.toml", "/%2e%2e/Cargo.toml"] {
            assert_eq!(respond(Request::builder().uri(path).body(vec![]).unwrap()).status(), 404);
        }
    }
    #[test]
    fn launcher_origin_is_exact_and_never_a_runtime_or_external_site() {
        assert!(is_url(&url()));
        for value in ["http://127.0.0.1:5173/", "https://example.com/", "http://neo-start.localhost.evil/index.html"] {
            assert!(!is_url(&value.parse().unwrap()));
        }
    }
}
