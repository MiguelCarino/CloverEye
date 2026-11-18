// CloverEye desktop shell (Tauri 2).
//
// Every request to the site's JSON API goes through clovereye-fetch's single
// queue (≤ 1 request/s, threads ≤ every 10 s, If-Modified-Since, back-off).
// Thumbnails and files are loaded by the webview straight from the image host.

#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use clovereye_fetch::models::{BoardsResponse, Catalog, Thread};
use clovereye_fetch::{live_client, Endpoint, Error as FetchError, Freshness, LiveClient};
use clovereye_ffcheck::FfmpegCheck;
use serde_json::Value;
use tauri::{Emitter, EventTarget, Manager};

// first: its log macros (log_info! ...) are used by every module below
#[macro_use]
mod diag;
mod ai;
mod extra;
mod library;
mod links;
mod offline;
mod stats;

/// Settings are plain JSON for C0; SQLite replaces this in C1 (SCOPE §4.1).
const SETTINGS_FILE: &str = "settings.json";
const MAX_SETTINGS_BYTES: usize = 256 * 1024;

struct AppState {
    client: Arc<LiveClient>,
    /// API requests waiting in the queue or under way, from every window.
    busy: Arc<AtomicUsize>,
}

/// Counts one API request for as long as it lives (fetch_busy).
struct Busy(Arc<AtomicUsize>);

impl Busy {
    fn new(n: &Arc<AtomicUsize>) -> Self {
        n.fetch_add(1, Ordering::SeqCst);
        Busy(n.clone())
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// How many API requests are waiting or under way. The Stats pane's
/// background sampling asks first and waits while the person's own
/// requests are in the queue.
#[tauri::command]
fn fetch_busy(state: tauri::State<'_, AppState>) -> usize {
    state.busy.load(Ordering::SeqCst)
}

/// Whether stored settings turn detailed logs on (Settings › Diagnostics).
fn detail_in(settings: &Value) -> bool {
    settings.pointer("/diagnostics/detailed") == Some(&Value::Bool(true))
}

/// The settings last read or written, to name the keys a save changed.
static LAST_SETTINGS: std::sync::Mutex<Option<Value>> = std::sync::Mutex::new(None);

/// Which settings a save changed, by name ("display.workMode", "tags"):
/// never their values. Objects keyed by plain names go one level down;
/// lists and objects keyed by data (lastRead's "g/123") stay whole.
fn changed_keys(old: Option<&Value>, new: &Value) -> Vec<String> {
    fn plain(o: &serde_json::Map<String, Value>) -> bool {
        o.keys().all(|k| !k.is_empty() && k.len() <= 32 && k.bytes().all(|c| c.is_ascii_alphabetic() || c == b'_'))
    }
    let empty = serde_json::Map::new();
    let old = old.and_then(Value::as_object).unwrap_or(&empty);
    let Some(new) = new.as_object() else { return Vec::new() };
    let mut keys: Vec<&String> = old.keys().chain(new.keys()).collect();
    keys.sort();
    keys.dedup();
    let mut out = Vec::new();
    for k in keys {
        let (a, b) = (old.get(k), new.get(k));
        if a == b {
            continue;
        }
        match (a.and_then(Value::as_object), b.and_then(Value::as_object)) {
            (Some(x), Some(y)) if plain(x) && plain(y) => {
                let mut subs: Vec<&String> = x.keys().chain(y.keys()).collect();
                subs.sort();
                subs.dedup();
                out.extend(subs.into_iter().filter(|s| x.get(*s) != y.get(*s)).map(|s| format!("{k}.{s}")));
            }
            _ => out.push(k.clone()),
        }
    }
    out.truncate(40);
    out
}

/// Reads settings.json at start for the Detailed logs switch, before any
/// window asks for it.
fn detail_from_disk(app: &tauri::AppHandle) {
    let Ok(path) = settings_path(app) else { return };
    if let Ok(Some(bytes)) = offline::read_capped(&path, MAX_SETTINGS_BYTES * 4) {
        if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
            diag::set_detailed(detail_in(&v));
        }
    }
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
async fn get_settings(app: tauri::AppHandle, webview: tauri::Webview) -> Result<Option<Value>, String> {
    let path = settings_path(&app)?;
    let t0 = std::time::Instant::now();
    let win = webview.label().to_string();
    // read through a cap: a file larger than any the app writes reads as corrupt
    match offline::read_capped(&path, MAX_SETTINGS_BYTES * 4) {
        Ok(Some(bytes)) => {
            let v = serde_json::from_slice::<Value>(&bytes).ok().filter(Value::is_object);
            match &v {
                Some(v) => {
                    log_info!("settings", "settings read", bytes = bytes.len(), keys = v.as_object().map_or(0, |o| o.len()), win = win, ms = diag::ms(t0));
                    *LAST_SETTINGS.lock().unwrap_or_else(|e| e.into_inner()) = Some(v.clone());
                }
                None => log_warn!("settings", "settings.json is not a settings object; starting from defaults", bytes = bytes.len(), win = win),
            }
            Ok(v)
        }
        Ok(None) => {
            log_warn!("settings", "settings.json is larger than CloverEye reads; starting from defaults", win = win);
            Ok(None)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            log_info!("settings", "no settings file yet (first start)", win = win);
            Ok(None)
        }
        Err(e) => {
            log_error!("settings", "settings.json could not be read", error = e, win = win);
            Err(format!("reading {}: {e}", path.display()))
        }
    }
}

/// Stores the settings object. Written to a unique temporary file, synced
/// and renamed, so a crash mid-write never leaves half a file. Saves from
/// every window go one at a time, each with its event, so the windows get
/// the 'settings-changed' events in the order the file was written.
#[tauri::command]
async fn set_settings(app: tauri::AppHandle, webview: tauri::Webview, settings: Value) -> Result<(), String> {
    if !settings.is_object() {
        return Err("settings must be a JSON object".into());
    }
    let t0 = std::time::Instant::now();
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        log_warn!("settings", "settings refused: too large", bytes = bytes.len(), max = MAX_SETTINGS_BYTES);
        return Err("settings are too large".into());
    }
    let path = settings_path(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    }
    // No .await below: a std Mutex held across the write and the emit.
    static SAVE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = SAVE.lock().unwrap_or_else(|e| e.into_inner());
    let write = || -> Result<(), String> {
        offline::write_atomic(&path, &bytes)?;
        Ok(())
    };
    if let Err(e) = write() {
        log_error!("settings", "settings could not be saved", error = diag::redact(&e, &[]), bytes = bytes.len());
        return Err(e);
    }
    {
        let mut last = LAST_SETTINGS.lock().unwrap_or_else(|e| e.into_inner());
        if diag::detailed() {
            let keys = changed_keys(last.as_ref(), &settings);
            log_debug!("settings", "settings saved", bytes = bytes.len(), changed = if keys.is_empty() { "none".to_string() } else { keys.join(",") }, win = webview.label(), ms = diag::ms(t0));
        }
        *last = Some(settings.clone());
    }
    // Settings › Diagnostics › Detailed logs, from whichever window
    let on = detail_in(&settings);
    if diag::set_detailed(on) {
        log_info!("settings", if on { "detailed logs on" } else { "detailed logs off" }, win = webview.label());
    }
    // Every window keeps the same settings: the others reload from this.
    // The window that saved is skipped when it listens on itself (a
    // listener on every target, `event.listen`, still gets it).
    let _ = app.emit_filter("settings-changed", &settings, others(webview.label()));
    Ok(())
}

/// An emit filter for every listener but those of window `label`.
fn others(label: &str) -> impl Fn(&EventTarget) -> bool + '_ {
    move |t| match t {
        EventTarget::Window { label: l } | EventTarget::Webview { label: l } | EventTarget::WebviewWindow { label: l } | EventTarget::AnyLabel { label: l } => l != label,
        _ => true,
    }
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
    let busy = Busy::new(&state.busy);
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = busy;
        let t0 = std::time::Instant::now();
        let fetched = client.get(&Endpoint::Boards).map_err(|e| e.to_string())?;
        let typed: BoardsResponse = fetched.json().map_err(|e| {
            log_warn!("net", "board list did not read", error = e);
            e.to_string()
        })?;
        log_debug!("net", "board list ready", boards = typed.boards.len(), freshness = freshness(fetched.freshness), bytes = fetched.body.len(), ms = diag::ms(t0));
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
    let busy = Busy::new(&state.busy);
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = busy;
        let t0 = std::time::Instant::now();
        let fetched = client.get(&Endpoint::Catalog(board.clone())).map_err(load_error)?;
        let typed: Catalog = fetched.json().map_err(|e| {
            log_warn!("catalog", "catalog did not read", board = board, error = e);
            load_error(e)
        })?;
        let data = serde_json::from_slice::<Value>(&fetched.body).map_err(|e| e.to_string())?;
        log_debug!("catalog", "catalog ready", board = board, pages = typed.len(), threads = typed.iter().map(|p| p.threads.len()).sum::<usize>(), freshness = freshness(fetched.freshness), bytes = fetched.body.len(), ms = diag::ms(t0));
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
    let busy = Busy::new(&state.busy);
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = busy;
        let t0 = std::time::Instant::now();
        let fetched = client.get(&Endpoint::Thread(board.clone(), no)).map_err(|e| {
            if e == FetchError::NotFound {
                log_debug!("thread", "thread is gone (404)", board = board, thread = no);
            }
            load_error(e)
        })?;
        let typed: Thread = fetched.json().map_err(|e| {
            log_warn!("thread", "thread did not read", board = board, thread = no, error = e);
            load_error(e)
        })?;
        let data = serde_json::from_slice::<Value>(&fetched.body).map_err(|e| e.to_string())?;
        log_debug!("thread", "thread ready", board = board, thread = no, posts = typed.posts.len(), freshness = freshness(fetched.freshness), bytes = fetched.body.len(), ms = diag::ms(t0));
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
    // The site's own domains, and what its captcha page loads in frames: the
    // Cloudflare check, and the site's abuse-check vendors (spur.us, mcl.io:
    // without them the site answers "Please unblock spur.us and mcl.io").
    let ok = ["4chan.org", "4cdn.org", "4channel.org", "spur.us", "mcl.io"]
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
        || host == "challenges.cloudflare.com";
    if !ok {
        log_info!("post", "kept the site window from opening another site", host = host);
    }
    ok
}

/// Opens (or reuses) the post window on the site's own page. That window
/// has no access to the app's commands (capabilities list only "main").
#[tauri::command]
async fn open_post_window(app: tauri::AppHandle, board: String, thread: Option<u64>, quote: Option<u64>) -> Result<(), String> {
    let url: tauri::Url = post_url(&board, thread, quote)?.parse().map_err(|e| format!("{e}"))?;
    log_info!("post", "site post window", board = board, thread = thread.unwrap_or(0), quote = quote.is_some(), reused = app.get_webview_window("post").is_some());
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
    fn settings_changes_skip_the_window_that_saved() {
        let f = others("main");
        assert!(!f(&EventTarget::WebviewWindow { label: "main".into() }));
        assert!(!f(&EventTarget::AnyLabel { label: "main".into() }));
        assert!(f(&EventTarget::WebviewWindow { label: "w-2".into() }));
        assert!(f(&EventTarget::Webview { label: "w-2".into() }));
        assert!(f(&EventTarget::App));
    }

    #[test]
    fn a_save_names_the_keys_it_changed_never_their_values() {
        let old = serde_json::json!({ "theme": "dark", "display": { "workMode": false, "times": true }, "lastRead": { "g/1": 5 }, "tags": [{ "name": "secret" }], "diagnostics": { "detailed": false } });
        let new = serde_json::json!({ "theme": "dark", "display": { "workMode": true, "times": true }, "lastRead": { "g/1": 9 }, "tags": [{ "name": "other" }], "diagnostics": { "detailed": true }, "ai": { "enabled": true } });
        assert_eq!(changed_keys(Some(&old), &new), vec!["ai", "diagnostics.detailed", "display.workMode", "lastRead", "tags"]);
        assert!(changed_keys(Some(&new), &new).is_empty());
        assert_eq!(changed_keys(None, &serde_json::json!({ "theme": "x" })), vec!["theme"]);
        assert!(detail_in(&new) && !detail_in(&old) && !detail_in(&serde_json::json!({ "diagnostics": { "detailed": "yes" } })));
    }

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
        assert!(ok("https://mcl.spur.us/d/mcl.js"));
        assert!(ok("https://mcl.io/x"));
        assert!(!ok("https://notspur.us/"));
        assert!(!ok("http://boards.4chan.org/g/"));
        assert!(!ok("https://evil4chan.org/"));
        assert!(!ok("https://4chan.org.evil.com/"));
        assert!(!ok("https://example.com/"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn dmabuf_guard_only_before_the_webkit_fix() {
        assert!(needs_dmabuf_guard((2, 50, 4))); // the AppImage's own
        assert!(needs_dmabuf_guard((2, 52, 6))); // Ubuntu 26.04
        assert!(needs_dmabuf_guard((2, 54, 0)));
        assert!(!needs_dmabuf_guard((2, 54, 1)));
        assert!(!needs_dmabuf_guard((2, 54, 2)));
        assert!(!needs_dmabuf_guard((2, 56, 0)));
        assert!(!needs_dmabuf_guard((3, 0, 0)));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn http1_only_with_libsoup_older_than_3_8() {
        assert!(needs_http1((3, 0, 7))); // Ubuntu 22.04, the AppImage's own
        assert!(needs_http1((3, 4, 4))); // Ubuntu 24.04
        assert!(needs_http1((3, 6, 6))); // Ubuntu 26.04
        assert!(!needs_http1((3, 8, 0)));
        assert!(!needs_http1((3, 8, 1))); // Fedora 45
        assert!(!needs_http1((4, 0, 0)));
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

/// WebKitGTK before 2.54.1 can corrupt its heap while a web process exits
/// (WebKit bugs 305909 and 315577): a thread tears down its GL context while
/// the process's exit handlers free the EGL display, and the web process
/// aborts as CloverEye closes. Ubuntu 26.04's 2.52.6 and the AppImage's own
/// WebKit are affected. Turning off WebKit's DMA-BUF renderer avoids that
/// path. Only for those versions, and never over the person's own choice;
/// CLOVEREYE_KEEP_DMABUF=1 keeps the renderer.
#[cfg(target_os = "linux")]
fn webkit_exit_crash_guard() {
    use webkit2gtk::ffi;
    let v = unsafe { (ffi::webkit_get_major_version(), ffi::webkit_get_minor_version(), ffi::webkit_get_micro_version()) };
    if !needs_dmabuf_guard(v) || std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() || std::env::var_os("CLOVEREYE_KEEP_DMABUF").is_some() {
        return;
    }
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    diag::DMABUF_GUARD_SET.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// GStreamer prefers NVIDIA's decoders (nvcodec, in gst-plugins-bad) over
/// the software ones when they are installed. When CUDA cannot open the
/// device (a sandbox, a container, a driver and CUDA that do not match),
/// the decoder fails on the first frame and WebKit does not fall back: the
/// video shows "Failed to decode data" and never plays. 4chan's WebM, AV1
/// and MP4 decode easily in software, so those decoders are ranked out.
/// GST_PLUGIN_FEATURE_RANK set by hand wins; CLOVEREYE_HW_VIDEO=1 keeps them.
#[cfg(target_os = "linux")]
const NVIDIA_DECODERS: [&str; 14] = [
    "nvh264dec", "nvh265dec", "nvvp8dec", "nvvp9dec", "nvav1dec", "nvmpegvideodec", "nvmpeg2videodec", "nvmpeg4videodec", "nvjpegdec",
    "nvh264sldec", "nvh265sldec", "nvvp8sldec", "nvvp9sldec", "nvav1sldec",
];

#[cfg(target_os = "linux")]
fn video_decoder_ranks() {
    if std::env::var_os("GST_PLUGIN_FEATURE_RANK").is_some() || std::env::var_os("CLOVEREYE_HW_VIDEO").is_some_and(|v| v != "0" && !v.is_empty()) {
        return;
    }
    let ranks: Vec<String> = NVIDIA_DECODERS.iter().map(|d| format!("{d}:NONE")).collect();
    std::env::set_var("GST_PLUGIN_FEATURE_RANK", ranks.join(","));
}

/// libsoup before 3.8 (Ubuntu 22.04's 3.0.7, which the AppImage bundles;
/// 24.04's 3.4.4; 26.04's 3.6.6) fails an HTTP/2 answer from
/// mcl.spur.us with "HTTP/2 Error: NO_ERROR", where 3.8.1 reads it. The
/// captcha's abuse check then cannot load its script and the site says
/// "Please unblock spur.us and mcl.io". Over HTTP/1.1 the same libsoup
/// reads it, so WebKit uses HTTP/1.1 with those versions.
/// SOUP_FORCE_HTTP1 set by hand wins; CLOVEREYE_HTTP2=1 keeps HTTP/2.
#[cfg(target_os = "linux")]
fn http1_guard() {
    let keep = std::env::var_os("CLOVEREYE_HTTP2").is_some_and(|v| v != "0" && !v.is_empty());
    if keep || std::env::var_os("SOUP_FORCE_HTTP1").is_some() || !needs_http1(diag::soup_version()) {
        return;
    }
    std::env::set_var("SOUP_FORCE_HTTP1", "1");
    diag::HTTP1_GUARD_SET.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[cfg(target_os = "linux")]
fn needs_http1(v: (u32, u32, u32)) -> bool {
    v < (3, 8, 0)
}

#[cfg(target_os = "linux")]
fn needs_dmabuf_guard((major, minor, micro): (u32, u32, u32)) -> bool {
    (major, minor, micro) < (2, 54, 1)
}

#[cfg(target_os = "linux")]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn main() {
    diag::init_early();
    diag::before_report(|app| app.state::<AppState>().client.flush_summary());
    #[cfg(target_os = "linux")]
    {
        appimage_fonts();
        webkit_exit_crash_guard();
        video_decoder_ranks();
        http1_guard();
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            client: Arc::new(live_client()),
            busy: Arc::new(AtomicUsize::new(0)),
        })
        .manage(extra::AgentState::default())
        .manage(offline::OfflineState::default())
        .manage(library::LibraryState::default())
        .manage(stats::StatsState::default())
        .manage(ai::AiState::default())
        // saved threads' files, for CloverEye's own windows only (offline.rs)
        .register_asynchronous_uri_scheme_protocol(offline::SCHEME, offline::protocol)
        .register_asynchronous_uri_scheme_protocol(library::SCHEME, library::protocol)
        // CLOVEREYE_TRY_CAPTCHA=<board>: asks for one captcha at start and
        // prints what came back. For finding out why a captcha does not
        // arrive, from a terminal; it never posts.
        .setup(|app| {
            diag::init(app.handle());
            detail_from_disk(app.handle());
            diag::startup(app.handle());
            if let Some(w) = app.get_webview_window("main") {
                extra::side_buttons(&w);
            }
            if let Ok(board) = std::env::var("CLOVEREYE_TRY_CAPTCHA") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    // "g" or "g/123" (a reply to thread 123)
                    let (b, t) = board.split_once('/').map(|(b, t)| (b.to_string(), t.parse::<u64>().unwrap_or(0))).unwrap_or((board.clone(), 0));
                    let args = serde_json::json!({ "board": b, "thread": t });
                    match extra::post_agent(handle, "captcha".into(), args).await {
                        Ok(v) if std::env::var_os("CLOVEREYE_TRY_CAPTCHA_FILE").is_some() => {
                            let path = std::env::var_os("CLOVEREYE_TRY_CAPTCHA_FILE").unwrap_or_default();
                            let _ = std::fs::write(&path, v.to_string());
                            diag::note("post helper: try-captcha saved to CLOVEREYE_TRY_CAPTCHA_FILE");
                        }
                        Ok(v) => diag::note(&format!("post helper: try-captcha answered: {}", v.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>().join(",")).unwrap_or_default())),
                        Err(e) => diag::note(&format!("post helper: try-captcha failed: {e}")),
                    }
                });
            }
            Ok(())
        })
        // The hidden post helper must not keep the app alive: when the last
        // CloverEye window closes, the app ends.
        .on_window_event(|window, event| {
            // A CloverEye window closing first plays its closing animation:
            // the request is held, the page animates and closes again
            // (window.__ceClosing in app.js); that second request goes
            // through. A page that does not answer is closed after a second.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label().to_string();
                let web = window.app_handle().get_webview_window(&label);
                if let Some(web) = web.filter(|_| (label == "main" || label.starts_with("w-")) && closing::first(&label)) {
                    log_debug!("app", "window closing (animation)", win = label);
                    api.prevent_close();
                    let ok = web.eval("window.__ceClosing ? window.__ceClosing() : window.__TAURI__?.window?.getCurrentWindow?.().close()").is_ok();
                    let w = web.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(if ok { 1000 } else { 0 }));
                        let _ = w.destroy();
                    });
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                closing::done(window.label());
                let app = window.app_handle();
                if window.label() == extra::AGENT_LABEL {
                    extra::agent_closed(app);
                }
                let left = app.webview_windows().keys().filter(|l| *l != window.label() && (*l == "main" || l.starts_with("w-"))).count();
                let own = window.label() == "main" || window.label().starts_with("w-");
                if own || window.label() == "post" {
                    log_info!("app", "window closed", win = window.label(), windows_left = left);
                }
                if left == 0 && own {
                    app.state::<AppState>().client.flush_summary();
                    log_info!("app", "last window closed; quitting");
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
            fetch_busy,
            open_post_window,
            extra::post_agent,
            extra::post_agent_reply,
            extra::post_agent_show,
            extra::open_window,
            extra::save_media,
            offline::offline_list,
            offline::offline_read,
            offline::offline_write_thread,
            offline::offline_fetch_file,
            offline::offline_delete,
            offline::download_file,
            library::library_load,
            library::library_save,
            library::library_fetch,
            library::library_import,
            library::library_delete,
            library::library_browse,
            library::library_import_dir,
            links::open_link,
            stats::stats_read,
            stats::stats_write,
            diag::diagnostics_text,
            diag::diagnostics_save,
            diag::diagnostics_note,
            diag::diagnostics_log,
            diag::set_log_detail,
            ai::ai_detect,
            ai::ai_chat,
            ai::ai_stop,
            ai::ai_loaded,
            ai::ai_unload
        ])
        .build(tauri::generate_context!())
        .expect("error while running CloverEye")
        .run(|app, event| {
            // Quitting (Cmd+Q, the app menu): each window closes with its
            // animation, and the last one to go ends the app.
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                let windows: Vec<_> = app.webview_windows().into_iter().filter(|(l, _)| l == "main" || l.starts_with("w-")).map(|(_, w)| w).collect();
                if !windows.is_empty() {
                    api.prevent_exit();
                    for w in windows {
                        let _ = w.close();
                    }
                }
            }
        });
}

/// Which windows are already playing their closing animation.
mod closing {
    use std::collections::HashSet;
    use std::sync::Mutex;

    static CLOSING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

    /// True the first time a window asks to close (hold it and animate);
    /// false after (let it go).
    pub fn first(label: &str) -> bool {
        CLOSING.lock().unwrap().get_or_insert_with(HashSet::new).insert(label.to_string())
    }

    pub fn done(label: &str) {
        if let Some(set) = CLOSING.lock().unwrap().as_mut() {
            set.remove(label);
        }
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn the_first_close_is_held_the_second_goes_through() {
            assert!(super::first("w-test"));
            assert!(!super::first("w-test"));
            super::done("w-test");
            assert!(super::first("w-test"));
            super::done("w-test");
        }
    }
}
