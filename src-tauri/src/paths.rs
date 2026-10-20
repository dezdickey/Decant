//! Path safety for the one thing the core deletes: a file inside the folder
//! being offloaded. The page names a folder and a path relative to it; this
//! module refuses anything that would land outside that folder.

use std::path::{Component, Path, PathBuf};

#[derive(Debug, PartialEq)]
pub enum PathError {
    /// The relative part was absolute, empty, or climbed with `..`.
    NotRelative,
    /// After resolving links, the file is not under the folder.
    Outside,
    /// The folder or the file does not exist, or is not a plain file.
    Missing,
}

impl std::fmt::Display for PathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            PathError::NotRelative => "the file path must be relative to the folder, without '..'",
            PathError::Outside => "the file is not inside the folder",
            PathError::Missing => "the file does not exist, or is not a plain file",
        })
    }
}

/// Resolve `rel` inside `root`, returning the real path of a regular file
/// that is guaranteed to sit under `root`.
///
/// Two layers, because either alone can be fooled: the text of `rel` must be
/// plainly relative with no `..`, and then the resolved path (links followed)
/// must still start with the resolved folder.
pub fn resolve_inside(root: &str, rel: &str) -> Result<PathBuf, PathError> {
    if rel.is_empty() {
        return Err(PathError::NotRelative);
    }
    for part in Path::new(rel).components() {
        match part {
            Component::Normal(_) | Component::CurDir => {}
            // `..`, a drive letter, a leading slash or a UNC prefix.
            _ => return Err(PathError::NotRelative),
        }
    }
    let root = Path::new(root).canonicalize().map_err(|_| PathError::Missing)?;
    let full = root.join(rel).canonicalize().map_err(|_| PathError::Missing)?;
    if !full.starts_with(&root) || full == root {
        return Err(PathError::Outside);
    }
    let meta = std::fs::symlink_metadata(&full).map_err(|_| PathError::Missing)?;
    if !meta.is_file() {
        return Err(PathError::Missing);
    }
    Ok(full)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("decant-paths-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("folder/sub")).unwrap();
        fs::write(dir.join("folder/a.txt"), b"a").unwrap();
        fs::write(dir.join("folder/sub/b.txt"), b"b").unwrap();
        fs::write(dir.join("secret.txt"), b"outside").unwrap();
        dir
    }

    #[test]
    fn accepts_files_inside() {
        let d = sandbox("inside");
        let root = d.join("folder");
        let root = root.to_str().unwrap();
        assert!(resolve_inside(root, "a.txt").is_ok());
        assert!(resolve_inside(root, "sub/b.txt").is_ok());
        assert!(resolve_inside(root, "./sub/b.txt").is_ok());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn refuses_climbing_out() {
        let d = sandbox("climb");
        let root = d.join("folder");
        let root = root.to_str().unwrap();
        assert_eq!(resolve_inside(root, "../secret.txt"), Err(PathError::NotRelative));
        assert_eq!(resolve_inside(root, "sub/../../secret.txt"), Err(PathError::NotRelative));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn refuses_absolute_paths() {
        let d = sandbox("absolute");
        let root = d.join("folder");
        let secret = d.join("secret.txt");
        assert_eq!(resolve_inside(root.to_str().unwrap(), secret.to_str().unwrap()), Err(PathError::NotRelative));
        assert_eq!(resolve_inside(root.to_str().unwrap(), "/etc/passwd"), Err(PathError::NotRelative));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn refuses_folders_missing_files_and_empty_paths() {
        let d = sandbox("missing");
        let root = d.join("folder");
        let root = root.to_str().unwrap();
        assert_eq!(resolve_inside(root, "sub"), Err(PathError::Missing));
        assert_eq!(resolve_inside(root, "nope.txt"), Err(PathError::Missing));
        assert_eq!(resolve_inside(root, ""), Err(PathError::NotRelative));
        assert_eq!(resolve_inside(root, "."), Err(PathError::Outside));
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_links_that_escape() {
        let d = sandbox("link");
        std::os::unix::fs::symlink(d.join("secret.txt"), d.join("folder/escape.txt")).unwrap();
        let root = d.join("folder");
        assert_eq!(resolve_inside(root.to_str().unwrap(), "escape.txt"), Err(PathError::Outside));
        let _ = fs::remove_dir_all(&d);
    }
}

#[cfg(test)]
mod properties {
    //! Thousands of generated paths, built from the pieces most likely to
    //! cause trouble, against one rule: whatever the input, the check never
    //! approves a path outside the folder, and never approves one that
    //! climbs with `..`.
    use super::*;
    use proptest::prelude::*;
    use std::sync::OnceLock;

    fn sandbox() -> &'static (PathBuf, PathBuf) {
        static S: OnceLock<(PathBuf, PathBuf)> = OnceLock::new();
        S.get_or_init(|| {
            let dir = std::env::temp_dir().join(format!("decant-props-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("folder/sub")).unwrap();
            std::fs::write(dir.join("folder/a.txt"), b"a").unwrap();
            std::fs::write(dir.join("folder/sub/b.txt"), b"b").unwrap();
            std::fs::write(dir.join("secret.txt"), b"outside").unwrap();
            let root = dir.join("folder");
            let canon = root.canonicalize().unwrap();
            (root, canon)
        })
    }

    fn segment() -> impl Strategy<Value = String> {
        prop_oneof![
            Just("a.txt".to_string()),
            Just("sub".to_string()),
            Just("b.txt".to_string()),
            Just("secret.txt".to_string()),
            Just("folder".to_string()),
            Just("..".to_string()),
            Just(".".to_string()),
            Just(String::new()),
            Just("C:".to_string()),
            Just(r"\\?".to_string()),
            "[a-z.~]{1,5}",
        ]
    }

    fn relative() -> impl Strategy<Value = String> {
        (
            prop::sample::select(vec!["", "/", r"\", "./", "../", r"C:\", r"\\server\share\"]),
            prop::collection::vec(segment(), 1..7),
            prop::sample::select(vec!["/", "\\"]),
        )
            .prop_map(|(lead, segs, sep)| format!("{lead}{}", segs.join(sep)))
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(4000))]

        #[test]
        fn never_approves_anything_outside_the_folder(rel in relative()) {
            let (root, canon) = sandbox();
            if let Ok(path) = resolve_inside(root.to_str().unwrap(), &rel) {
                prop_assert!(path.starts_with(canon), "{rel:?} escaped to {path:?}");
                prop_assert!(path != *canon, "{rel:?} resolved to the folder itself");
                prop_assert!(path.is_file(), "{rel:?} is not a file");
                prop_assert!(
                    !Path::new(&rel).components().any(|c| matches!(c, Component::ParentDir)),
                    "{rel:?} climbs with '..' yet was approved"
                );
            }
        }
    }
}
