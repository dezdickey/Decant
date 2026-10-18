fn main() {
    // Name every command the page may call. Anything not listed here, and not
    // granted in capabilities/default.json, is refused by Tauri before it
    // reaches Offload's code.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["rc", "free_file", "app_info"]),
        ),
    )
    .expect("failed to run tauri-build");
}
