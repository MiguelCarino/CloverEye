fn main() {
    // Declaring the app's commands makes Tauri generate one permission per
    // command (allow-get-settings, ...), so capabilities/default.json can
    // allow exactly these and nothing else.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "get_settings",
            "set_settings",
            "check_ffmpeg",
            "fetch_boards",
            "fetch_catalog",
            "fetch_thread",
            "open_post_window",
            "post_agent",
            "post_agent_reply",
            "post_agent_show",
            "open_window",
            "save_media",
        ])),
    )
    .expect("failed to run tauri-build");
}
