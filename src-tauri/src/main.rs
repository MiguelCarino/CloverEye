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
use tauri::{Emitter, Manager};

mod extra;

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
    // Every window keeps the same settings: the others reload from this.
    let _ = app.emit("settings-changed", &settings);
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

/// The page that holds the site's own post form: the thread (with `#q<no>`
/// to open the quick reply quoting a post) or the board index for a new
/// thread. The person posts there, solving the site's own captcha.
fn post_url(board: &str, thread: Option<u64>, quote: Option<u64>) -> Result<String, String> {
    if !clovereye_fetch::valid_board(board) {
        return Err(format!("not a board code: {board:?}"));
    }
    Ok(match (thread, quote) {
        (Some(t), Some(q)) if t > 0 && q > 0 => format!("https://boards.4chan.org/{board}/thread/{t}#q{q}"),
        (Some(t), _) if t > 0 => format!("https://boards.4chan.org/{board}/thread/{t}#bottom"),
        (Some(_), _) => return Err("not a thread number".into()),
        (None, _) => format!("https://boards.4chan.org/{board}/"),
    })
}

/// The post window may only move around the site itself (pages, the post
/// endpoint, its captcha, its static files) and Cloudflare's challenge
/// page. Anything else is refused there.
pub(crate) fn post_window_allows(url: &tauri::Url) -> bool {
    if url.scheme() == "about" {
        return true;
    }
    if url.scheme() != "https" {
        return false;
    }
    let host = url.host_str().unwrap_or_default();
    ["4chan.org", "4cdn.org", "4channel.org"]
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
        || host == "challenges.cloudflare.com"
}

/// Opens (or reuses) the post window on the site's own page. That window
/// has no access to the app's commands (capabilities list only "main").
#[tauri::command]
async fn open_post_window(app: tauri::AppHandle, board: String, thread: Option<u64>, quote: Option<u64>) -> Result<(), String> {
    let url: tauri::Url = post_url(&board, thread, quote)?.parse().map_err(|e| format!("{e}"))?;
    if let Some(win) = app.get_webview_window("post") {
        win.navigate(url).map_err(|e| e.to_string())?;
        let _ = win.unminimize();
        let _ = win.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, "post", tauri::WebviewUrl::External(url))
        .title("Post · CloverEye")
        .inner_size(1000.0, 860.0)
        .min_inner_size(480.0, 480.0)
        .on_navigation(post_window_allows)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn post_urls() {
        assert_eq!(post_url("g", Some(123), Some(456)).unwrap(), "https://boards.4chan.org/g/thread/123#q456");
        assert_eq!(post_url("g", Some(123), None).unwrap(), "https://boards.4chan.org/g/thread/123#bottom");
        assert_eq!(post_url("wsg", None, None).unwrap(), "https://boards.4chan.org/wsg/");
        assert!(post_url("../x", None, None).is_err());
        assert!(post_url("G", None, None).is_err());
        assert!(post_url("g", Some(0), None).is_err());
    }

    #[test]
    fn post_window_stays_on_the_site() {
        let ok = |u: &str| post_window_allows(&u.parse().unwrap());
        assert!(ok("https://boards.4chan.org/g/thread/1"));
        assert!(ok("https://sys.4chan.org/g/post"));
        assert!(ok("https://i.4cdn.org/g/1.jpg"));
        assert!(ok("https://challenges.cloudflare.com/x"));
        assert!(!ok("http://boards.4chan.org/g/"));
        assert!(!ok("https://evil4chan.org/"));
        assert!(!ok("https://4chan.org.evil.com/"));
        assert!(!ok("https://example.com/"));
    }
}

/// The AppImage carries its own WebKit (from Ubuntu 22.04), which aborts
/// while drawing some colour fonts (COLRv1, as Fedora's colour emoji): the
/// page just dies. Inside the AppImage, fonts are the system's minus the
/// colour ones. CLOVEREYE_COLOR_FONTS=1 keeps them.
#[cfg(target_os = "linux")]
fn appimage_fonts() {
    if std::env::var_os("APPIMAGE").is_none() || std::env::var_os("CLOVEREYE_COLOR_FONTS").is_some() {
        return;
    }
    let base = std::env::var_os("FONTCONFIG_FILE")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("/etc/fonts/fonts.conf"));
    let dir = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .map(|d| d.join("clovereye"));
    let Some(dir) = dir else { return };
    let conf = dir.join("fonts-no-colour.conf");
    let text = format!(
        "<?xml version=\"1.0\"?>\n<!DOCTYPE fontconfig SYSTEM \"urn:fontconfig:fonts.dtd\">\n<!-- Written by CloverEye (AppImage): the system's fonts minus colour fonts, which crash the bundled WebKit. -->\n<fontconfig>\n  <include ignore_missing=\"yes\">{}</include>\n  <selectfont>\n    <rejectfont>\n      <pattern><patelt name=\"color\"><bool>true</bool></patelt></pattern>\n    </rejectfont>\n  </selectfont>\n</fontconfig>\n",
        xml_escape(&base.to_string_lossy())
    );
    if std::fs::create_dir_all(&dir).is_ok() && std::fs::write(&conf, text).is_ok() {
        std::env::set_var("FONTCONFIG_FILE", &conf);
    }
}

#[cfg(target_os = "linux")]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn main() {
    #[cfg(target_os = "linux")]
    appimage_fonts();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            client: Arc::new(live_client()),
        })
        .manage(extra::AgentState::default())
        // CLOVEREYE_TRY_CAPTCHA=<board>: asks for one captcha at start and
        // prints what came back. For finding out why a captcha does not
        // arrive, from a terminal; it never posts.
        .setup(|app| {
            if let Ok(board) = std::env::var("CLOVEREYE_TRY_CAPTCHA") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    let args = serde_json::json!({ "board": board, "thread": 0 });
                    match extra::post_agent(handle, "captcha".into(), args).await {
                        Ok(v) => eprintln!("clovereye post helper: try-captcha answered: {}", v.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>().join(",")).unwrap_or_default()),
                        Err(e) => eprintln!("clovereye post helper: try-captcha failed: {e}"),
                    }
                });
            }
            Ok(())
        })
        // The hidden post helper must not keep the app alive: when the last
        // CloverEye window closes, the app ends.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle();
                if window.label() == extra::AGENT_LABEL {
                    extra::agent_closed(app);
                }
                let content = app
                    .webview_windows()
                    .keys()
                    .any(|l| l != window.label() && (l == "main" || l.starts_with("w-")));
                if !content && (window.label() == "main" || window.label().starts_with("w-")) {
                    app.exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            check_ffmpeg,
            fetch_boards,
            fetch_catalog,
            fetch_thread,
            open_post_window,
            extra::post_agent,
            extra::post_agent_reply,
            extra::post_agent_show,
            extra::open_window,
            extra::save_media
        ])
        .run(tauri::generate_context!())
        .expect("error while running CloverEye");
}
