//! Shared build-time validation; never include input, paths or parser errors in diagnostics.
use serde_json::{json, Value};
use std::{fs::File, io::Read, path::Path};

const MAX_BYTES: u64 = 16 * 1024;

pub fn validate(bytes: &[u8]) -> Result<String, &'static str> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "Control config: invalid JSON")?;
    let object = value.as_object().ok_or("Control config: expected object")?;
    if object.keys().any(|key| !matches!(key.as_str(), "enabled" | "url" | "allowHttp" | "key")) {
        return Err("Control config: unsupported field; only enabled, url, allowHttp and device key are accepted (no administrator credentials)");
    }
    if value.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Err("Control config: enabled must be true; omit build configuration to disable");
    }
    let allow_http = match value.get("allowHttp") {
        None => false,
        Some(Value::Bool(value)) => *value,
        _ => return Err("Control config: allowHttp must be boolean"),
    };
    let key = value.get("key").and_then(Value::as_str).ok_or("Control config: device key required")?;
    // Canonical standard base64 for exactly 32 bytes (last sextet has two zero bits).
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if key.len() != 44 || !key.ends_with('=')
        || !key.as_bytes()[..43].iter().all(|c| ALPHABET.contains(c))
        || !ALPHABET.iter().position(|c| *c == key.as_bytes()[42]).is_some_and(|n| n % 4 == 0)
    {
        return Err("Control config: key must be a canonical 32-byte base64 device key, not a password");
    }
    let url = value.get("url").and_then(Value::as_str).ok_or("Control config: URL required")?;
    validate_origin(url, allow_http)?;
    serde_json::to_string(&json!({"enabled":true,"url":url.trim_end_matches('/'),"allowHttp":allow_http,"key":key}))
        .map_err(|_| "Control config: serialization failed")
}

fn validate_origin(url: &str, allow_http: bool) -> Result<(), &'static str> {
    const ERROR: &str = "Control config: expected HTTP(S) origin without credentials, path, query or fragment; remote HTTP requires allowHttp:true";
    let (scheme, authority) = url.split_once("://").ok_or(ERROR)?;
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    if authority.is_empty() || authority.bytes().any(|c| !c.is_ascii() || c.is_ascii_control() || c.is_ascii_whitespace() || b"/@?#\\%".contains(&c)) {
        return Err(ERROR);
    }
    let (host, port) = if authority.starts_with('[') {
        let end = authority.find(']').ok_or(ERROR)?;
        let host = &authority[1..end];
        host.parse::<std::net::Ipv6Addr>().map_err(|_| ERROR)?;
        let tail = &authority[end + 1..];
        (host, if tail.is_empty() { None } else { Some(tail.strip_prefix(':').ok_or(ERROR)?) })
    } else {
        let (host, port) = authority.split_once(':').map_or((authority, None), |(h, p)| (h, Some(p)));
        if host.len() > 253 || host.split('.').any(|label| label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-') || !label.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')) {
            return Err(ERROR);
        }
        (host, port)
    };
    if let Some(port) = port {
        if port.is_empty() || !port.bytes().all(|c| c.is_ascii_digit()) || port.parse::<u16>().ok().filter(|p| *p != 0).is_none() { return Err(ERROR); }
    }
    let loopback = host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1";
    if scheme != "https" && !(scheme == "http" && (allow_http || loopback)) { return Err(ERROR); }
    Ok(())
}

pub fn load(path: Option<&Path>) -> Result<String, &'static str> {
    let Some(path) = path else { return Ok("null".into()); };
    let mut bytes = Vec::new();
    File::open(path).map_err(|_| "Control config: cannot open private build config")?
        .take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|_| "Control config: cannot read private build config")?;
    if bytes.len() as u64 > MAX_BYTES { return Err("Control config: exceeds size limit"); }
    validate(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Value { json!({"enabled":true,"url":"https://control.example.invalid","key":format!("{}=", "A".repeat(43))}) }
    fn check(value: Value) -> Result<String, &'static str> { validate(&serde_json::to_vec(&value).unwrap()) }
    #[test]
    fn private_file_loading_and_limits() {
        let path = std::env::temp_dir().join(format!("neo-build-config-{}-{}.json", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        assert!(load(Some(&path)).is_err());
        std::fs::write(&path, serde_json::to_vec(&config()).unwrap()).unwrap();
        assert_eq!(load(Some(&path)).unwrap(), check(config()).unwrap());
        std::fs::write(&path, vec![b' '; MAX_BYTES as usize + 1]).unwrap();
        assert_eq!(load(Some(&path)).unwrap_err(), "Control config: exceeds size limit");
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn absent_config_is_null() { assert_eq!(load(None).unwrap(), "null"); }
    #[test]
    fn valid_config_serializes_only_whitelisted_fields() {
        let saved: Value = serde_json::from_str(&check(config()).unwrap()).unwrap();
        assert_eq!(saved["enabled"], true); assert_eq!(saved["allowHttp"], false); assert_eq!(saved.as_object().unwrap().len(), 4);
    }
    #[test]
    fn rejects_admin_credentials_and_unknown_fields() {
        for field in ["root", "password", "adminPassword", "username", "deviceId", "token"] {
            let mut v = config(); v[field] = json!("private-password");
            let error = check(v).unwrap_err(); assert!(!error.contains("private-password"));
        }
    }
    #[test]
    fn fields_required_and_strictly_typed() {
        for field in ["enabled", "url", "key"] {
            let mut v = config(); v.as_object_mut().unwrap().remove(field); assert!(check(v).is_err());
            let mut v = config(); v[field] = json!(123); assert!(check(v).is_err());
        }
        let mut v = config(); v["enabled"] = json!(false); assert!(check(v).is_err());
        let mut v = config(); v["allowHttp"] = json!("true"); assert!(check(v).is_err());
    }
    #[test]
    fn rejects_passwords_and_noncanonical_keys() {
        for key in ["root", "password", &"A".repeat(44), &format!("{}B=", "A".repeat(42)), &format!("{}!=", "A".repeat(42))] {
            let mut v = config(); v["key"] = json!(key); assert!(check(v).is_err());
        }
    }
    #[test]
    fn url_policy() {
        for url in ["https://control.example.invalid/", "https://control.example.invalid:443", "http://localhost:8080", "http://127.0.0.1", "http://[::1]:8080"] {
            let mut v = config(); v["url"] = json!(url); assert!(check(v).is_ok(), "{url}");
        }
        for url in ["http://remote.invalid", "ftp://host", "https://root:password@host", "https://host?secret=x", "https://host#x", "https://host/path", "https://host\\path", "https://host\n", "https://host:65536", "https://host:", "https://[bad]", "https://-bad", "https://"] {
            let mut v = config(); v["url"] = json!(url); assert!(check(v).is_err(), "{url}");
        }
        let mut v = config(); v["url"] = json!("http://remote.invalid"); v["allowHttp"] = json!(true); assert!(check(v).is_ok());
    }
    #[test]
    fn parser_errors_are_redacted() {
        let error = validate(b"{ secret-password").unwrap_err(); assert!(!error.contains("secret-password"));
        assert!(validate(b"null").is_err()); assert!(validate(b"[]").is_err());
    }
}
