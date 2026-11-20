fn main() {
    // Declaring the app's own commands generates `allow-<command>` permissions, which the GUI
    // (a remote page served by the core on 127.0.0.1) needs in its capability to call them.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["pick_folder", "set_theme", "set_zoom", "open_external"])),
    )
    .expect("failed to run tauri-build");
}
