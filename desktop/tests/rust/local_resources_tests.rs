use super::*;

#[test]
fn only_the_exact_running_local_origin_is_trusted() {
    let runtime = "http://127.0.0.1:45123";
    assert!(trusted_runtime_origin(
        &format!("{runtime}/chat").parse().unwrap(),
        runtime
    ));
    for url in [
        "http://127.0.0.1:45124",
        "http://localhost:45123",
        "https://127.0.0.1:45123",
        "https://example.com",
        "http://127.0.0.1.evil.test:45123",
    ] {
        assert!(
            !trusted_runtime_origin(&url.parse().unwrap(), runtime),
            "{url}"
        );
    }
    assert!(!trusted_runtime_origin(
        &"https://example.com".parse().unwrap(),
        "https://example.com"
    ));
    assert!(!trusted_runtime_origin(
        &runtime.parse().unwrap(),
        "invalid"
    ));
}

#[test]
fn local_file_validation_never_executes_or_copies_the_file() {
    let root = std::env::temp_dir().join(format!(
        "neo-reveal-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join("中文 [report], original.txt");
    std::fs::write(&file, b"original").unwrap();
    assert_eq!(existing_local_file(&file).unwrap(), file);
    assert!(existing_local_file(&root).is_err());
    assert!(existing_local_file(&root.join("missing")).is_err());
    assert!(existing_local_file(Path::new("relative.txt")).is_err());
    assert!(existing_local_file(Path::new("https://example.com/file")).is_err());
    #[cfg(windows)]
    for path in [
        r"\\server\share\file",
        r"\\?\C:\file",
        r"\\.\NUL",
        r"C:relative",
        "C:\\bad\0file",
    ] {
        assert!(existing_local_file(Path::new(path)).is_err());
    }
    assert_eq!(std::fs::read(&file).unwrap(), b"original");
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    std::fs::remove_dir_all(root).unwrap();
}
