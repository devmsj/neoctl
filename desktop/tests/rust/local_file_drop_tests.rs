use super::*;

#[test]
fn native_drop_references_are_one_shot_deduplicated_and_bounded() {
    let mut state = DropState::default();
    let path = PathBuf::from("C:/original.txt");
    let id = state.retain_drop(&[path.clone(), path.clone()]).unwrap();
    assert_eq!(state.take(id).unwrap(), vec![path.clone()]);
    assert!(state.take(id).is_err());
    assert!(state.take(999).is_err());
    assert!(state.retain_drop(&vec![path.clone(); 257]).is_err());
    let old = state.retain_drop(&[path.clone()]).unwrap();
    for _ in 0..20 {
        state.retain_drop(&[path.clone()]).unwrap();
    }
    assert_eq!(state.pending.len(), 16);
    assert!(state.take(old).is_err());
}

#[test]
fn references_preserve_original_paths_and_contents_without_copying() {
    let root = std::env::temp_dir().join(format!(
        "neo-drop-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    for name in ["中文 [report], original.txt", "photo.png", "empty.bin"] {
        let file = root.join(name);
        std::fs::write(
            &file,
            if name == "empty.bin" {
                b"".as_slice()
            } else {
                b"original".as_slice()
            },
        )
        .unwrap();
        let info = reference(&file).unwrap();
        assert_eq!(info.absolute_path, file.to_str().unwrap());
        assert_eq!(info.kind, "file");
        assert_eq!(info.name, name);
        assert_eq!(info.size, std::fs::metadata(&file).unwrap().len());
        let json = serde_json::to_value(&info).unwrap();
        assert!(json.get("data").is_none());
        assert!(json.get("previewUrl").is_none());
        assert!(json.get("absolutePath").is_some());
        std::fs::write(&file, b"changed").unwrap();
        assert_eq!(std::fs::read(&info.absolute_path).unwrap(), b"changed");
        std::fs::remove_file(&file).unwrap();
        assert!(reference(&file).is_err());
    }
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    assert!(reference(&root).is_err());
    assert!(reference(std::path::Path::new("relative.txt")).is_err());
    std::fs::remove_dir_all(root).unwrap();
}
