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
            "offline_list",
            "offline_read",
            "offline_write_thread",
            "offline_fetch_file",
            "offline_delete",
            "download_file",
            "library_load",
            "library_save",
            "library_fetch",
            "library_import",
            "library_delete",
            "library_browse",
            "library_import_dir",
            "open_link",
            "fetch_busy",
            "stats_read",
            "stats_write",
            "diagnostics_text",
            "diagnostics_save",
            "diagnostics_note",
            "diagnostics_log",
            "set_log_detail",
            "ai_detect",
            "ai_chat",
            "ai_stop",
            "ai_loaded",
            "ai_unload",
        ])),
    )
    .expect("failed to run tauri-build");
}
