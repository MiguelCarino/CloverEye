// CloverEye desktop shell (Tauri 2).
//
// Every request to the site's JSON API goes through clovereye-fetch's single
// queue (≤ 1 request/s, threads ≤ every 10 s, If-Modified-Since, back-off).
// Thumbnails and files are loaded by the webview straight from the image host.

#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Arc;

use clovereye_fetch::models::{BoardsResponse, Catalog, Thread};
use clovereye_fetch::{live_client, Endpoint, Error as FetchError, Freshness, LiveClient};
use clovereye_ffcheck::FfmpegCheck;
use serde_json::Value;
use tauri::Manager;

/// Settings are plain JSON for C0; SQLite replaces this in C1 (SCOPE §4.1).
const SETTINGS_FILE: &str = "settings.json";
const MAX_SETTINGS_BYTES: usize = 256 * 1024;

struct AppState {
    client: Arc<LiveClient>,
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config folder: {e}"))?;
    Ok(dir.join(SETTINGS_FILE))
}

/// The stored settings object, or `null` on first launch. A corrupt file
/// also reads as `null`, so the UI starts from defaults instead of failing.
#[tauri::command]
async fn get_settings(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let path = settings_path(&app)?;
    match std::fs::read(&path) {
        Ok(bytes) => Ok(serde_json::from_slice::<Value>(&bytes).ok().filter(Value::is_object)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("reading {}: {e}", path.display())),
    }
}

/// Stores the settings object. Written to a temporary file and renamed, so
/// a crash mid-write never leaves half a file.
#[tauri::command]
async fn set_settings(app: tauri::AppHandle, settings: Value) -> Result<(), String> {
    if !settings.is_object() {
        return Err("settings must be a JSON object".into());
    }
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        return Err("settings are too large".into());
    }
    let path = settings_path(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("writing {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("saving {}: {e}", path.display()))?;
    Ok(())
}

/// Read-only ffmpeg check: `-version`, `-encoders`, `-filters`. Never
/// installs anything and never runs a package manager.
#[tauri::command]
async fn check_ffmpeg() -> Result<FfmpegCheck, String> {
    let app_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    tauri::async_runtime::spawn_blocking(move || clovereye_ffcheck::check(app_dir.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

/// boards.json through the shared queue (≤ 1 request/s, conditional,
/// back-off). Checked against the typed model, returned as the API sent it.
#[tauri::command]
async fn fetch_boards(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let client = state.client.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let fetched = client.get(&Endpoint::Boards).map_err(|e| e.to_string())?;
        let _typed: BoardsResponse = fetched.json().map_err(|e| e.to_string())?;
        serde_json::from_slice::<Value>(&fetched.body).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What the UI gets for a catalog or thread: the API's JSON plus how fresh
/// it is ("new" 200, "not-modified" 304, "throttled" inside the 10 s
/// thread floor, so no request was made).
#[derive(serde::Serialize)]
struct Loaded {
    freshness: &'static str,
    data: Value,
}

fn freshness(f: Freshness) -> &'static str {
    match f {
        Freshness::New => "new",
        Freshness::NotModified => "not-modified",
        Freshness::Throttled => "throttled",
    }
}

/// Errors the UI can act on: "not-found" (a pruned or deleted thread) gets
/// its own code; anything else is the fetch layer's message.
fn load_error(e: FetchError) -> String {
    match e {
        FetchError::NotFound => "not-found".into(),
        other => other.to_string(),
    }
}

/// A board's catalog (every thread, OP + last replies) through the shared
/// queue: ≤ 1 request/s for the whole app, If-Modified-Since, back-off.
#[tauri::command]
async fn fetch_catalog(state: tauri::State<'_, AppState>, board: String) -> Result<Loaded, String> {
    let client = state.client.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let fetched = client.get(&Endpoint::Catalog(board)).map_err(load_error)?;
        let _typed: Catalog = fetched.json().map_err(load_error)?;
        let data = serde_json::from_slice::<Value>(&fetched.body).map_err(|e| e.to_string())?;
        Ok(Loaded { freshness: freshness(fetched.freshness), data })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One thread through the shared queue. The fetch layer never asks for the
/// same thread more often than every 10 s (the API rule); inside that floor
/// it hands back the cached copy as "throttled".
#[tauri::command]
async fn fetch_thread(state: tauri::State<'_, AppState>, board: String, no: u64) -> Result<Loaded, String> {
    let client = state.client.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let fetched = client.get(&Endpoint::Thread(board, no)).map_err(load_error)?;
        let _typed: Thread = fetched.json().map_err(load_error)?;
        let data = serde_json::from_slice::<Value>(&fetched.body).map_err(|e| e.to_string())?;
        Ok(Loaded { freshness: freshness(fetched.freshness), data })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            client: Arc::new(live_client()),
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            check_ffmpeg,
            fetch_boards,
            fetch_catalog,
            fetch_thread
        ])
        .run(tauri::generate_context!())
        .expect("error while running CloverEye");
}
