// Posting from inside the app, more windows, and saving files.
//
// Posting: the site's captcha and post endpoints sit behind a browser check
// that answers 403 to a plain client (checked 5 November 2026). CloverEye
// does not pretend to be a browser; instead one hidden helper window, a real
// WebKit page on the site's own origin, does what the site's reply form does
// (src/post_agent.js). The reply form, the captcha pictures and the person's
// answer all live in CloverEye's own UI. If the site wants a browser check,
// the helper window is shown so the person can pass it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::webview::PageLoadEvent;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::{oneshot, Notify};

pub const AGENT_LABEL: &str = "post-agent";
const AGENT_JS: &str = include_str!("post_agent.js");
/// A captcha not here after this long: the helper window comes forward.
const SHOW_AFTER_SECS: u64 = 7;

#[derive(Default)]
pub struct AgentState {
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    ready: AtomicBool,
    ready_notify: Notify,
    counter: AtomicU64,
    windows: AtomicU64,
}

/// The helper's script, with two switches for finding out why a captcha
/// does not come, from a terminal: CLOVEREYE_HELPER_DEBUG=1 logs every
/// resource the captcha page loads or fails to load, and its console
/// errors; CLOVEREYE_CAPTCHA_PAGE=1 skips the frame and opens the captcha
/// page itself straight away.
fn env_on(k: &str) -> bool {
    std::env::var_os(k).is_some_and(|v| v != "0" && !v.is_empty())
}

fn debug_on() -> bool {
    env_on("CLOVEREYE_HELPER_DEBUG")
}

const FRAME_DEBUG_JS: &str = include_str!("frame_debug.js");

fn agent_script() -> String {
    let on = env_on;
    format!(
        "window.__ceDebug = {};\nwindow.__ceCaptchaPage = {};\n{}",
        on("CLOVEREYE_HELPER_DEBUG"),
        on("CLOVEREYE_CAPTCHA_PAGE"),
        AGENT_JS
    )
}

fn board_of(args: &Value) -> Result<String, String> {
    let b = args.get("board").and_then(Value::as_str).unwrap_or_default();
    if clovereye_fetch::valid_board(b) {
        Ok(b.to_string())
    } else {
        Err(format!("not a board code: {b:?}"))
    }
}

fn ensure_agent(app: &tauri::AppHandle, board: &str) -> Result<tauri::WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(AGENT_LABEL) {
        return Ok(w);
    }
    let state = app.state::<AgentState>();
    state.ready.store(false, Ordering::SeqCst);
    let mut url: tauri::Url = format!("https://boards.4chan.org/{board}/").parse().map_err(|e| format!("{e}"))?;
    // Debug only (CLOVEREYE_HELPER_DEBUG=1 and CLOVEREYE_HELPER_START=<url>):
    // the helper opens on another page the site's captcha needs, shown, to
    // see whether this window can load it at all.
    if debug_on() {
        if let Some(start) = std::env::var("CLOVEREYE_HELPER_START").ok().and_then(|u| u.parse::<tauri::Url>().ok()) {
            if crate::post_window_allows(&start) {
                url = start;
            }
        }
    }
    WebviewWindowBuilder::new(app, AGENT_LABEL, WebviewUrl::External(url))
        .title("Site check · CloverEye")
        .inner_size(900.0, 760.0)
        .visible(false)
        .initialization_script(&agent_script())
        .initialization_script_for_all_frames(if debug_on() { FRAME_DEBUG_JS } else { "" })
        .on_navigation(crate::post_window_allows)
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                webview.app_handle().state::<AgentState>().ready.store(false, Ordering::SeqCst);
            }
        })
        .build()
        .map(|w| {
            watch_crashes(&w);
            w
        })
        .map_err(|e| e.to_string())
}

async fn wait_ready(state: &AgentState, limit: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        if state.ready.load(Ordering::SeqCst) {
            return true;
        }
        let notified = state.ready_notify.notified();
        if state.ready.load(Ordering::SeqCst) {
            return true;
        }
        if tokio::time::timeout_at(deadline, notified).await.is_err() {
            return state.ready.load(Ordering::SeqCst);
        }
    }
}

/// Runs one helper request: "captcha" { board, thread } or "post" { board,
/// fields, file }. Returns what the site sent; "check-needed" when the site
/// wants a browser check first (the helper window is then shown).
#[tauri::command]
pub async fn post_agent(app: tauri::AppHandle, op: String, args: Value) -> Result<Value, String> {
    if op != "captcha" && op != "post" {
        return Err("unknown request".into());
    }
    let board = board_of(&args)?;
    let win = ensure_agent(&app, &board)?;
    let state = app.state::<AgentState>();
    if !wait_ready(&state, Duration::from_secs(20)).await {
        let _ = win.show();
        let _ = win.set_focus();
        return Err("check-needed".into());
    }
    let id = state.counter.fetch_add(1, Ordering::SeqCst).to_string();
    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(id.clone(), tx);
    eprintln!("clovereye post helper: request {id}: {op}");
    let req = json!({ "id": id, "op": op, "args": args });
    if let Err(e) = win.eval(&format!("window.__ceAgent && window.__ceAgent.run({req})")) {
        state.pending.lock().unwrap().remove(&id);
        return Err(e.to_string());
    }
    // A captcha can wait on the site's human check, which the person passes.
    // One that has not come after a few seconds brings the window forward
    // from here, whatever the page itself managed to say.
    let mut rx = rx;
    let mut limit = Duration::from_secs(if op == "post" { 180 } else { 200 });
    if op == "captcha" {
        let first = Duration::from_secs(SHOW_AFTER_SECS);
        if let Ok(done) = tokio::time::timeout(first, &mut rx).await {
            return done.unwrap_or_else(|_| Err("The helper stopped.".into()));
        }
        if state.pending.lock().unwrap().contains_key(&id) {
            eprintln!("clovereye post helper: no captcha after {SHOW_AFTER_SECS} s; showing the window");
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
        limit -= first;
    }
    match tokio::time::timeout(limit, rx).await {
        Ok(Ok(result)) => result,
        _ => {
            state.pending.lock().unwrap().remove(&id);
            Err(if op == "captcha" {
                "The captcha did not arrive in time (was the site's check left open?). Press New captcha to try again.".into()
            } else {
                "The site did not answer in time.".into()
            })
        }
    }
}

/// The helper window was closed (by the person, say, instead of passing the
/// site's check): whatever it was doing ends now, with a reason.
pub fn agent_closed(app: &tauri::AppHandle) {
    fail_pending(app, "The site check window was closed before the site answered.");
}

/// Ends every request in flight with `why`.
fn fail_pending(app: &tauri::AppHandle, why: &str) {
    let state = app.state::<AgentState>();
    state.ready.store(false, Ordering::SeqCst);
    let waiting: Vec<_> = state.pending.lock().unwrap().drain().map(|(_, tx)| tx).collect();
    for tx in waiting {
        let _ = tx.send(Err(why.to_string()));
    }
}

/// Brings the helper window forward (the reply form's "Show the site
/// window"), creating it on the board's page if it is not there.
#[tauri::command]
pub fn post_agent_show(app: tauri::AppHandle) -> Result<(), String> {
    let w = match app.get_webview_window(AGENT_LABEL) {
        Some(w) => w,
        None => ensure_agent(&app, "g")?,
    };
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    Ok(())
}

/// When the helper's web page dies (WebKit's web process crashed or was
/// killed), whatever it was doing ends with a reason, and the page reloads.
#[cfg(target_os = "linux")]
fn watch_crashes(win: &tauri::WebviewWindow) {
    use webkit2gtk::{WebViewExt, WebProcessTerminationReason};
    let app = win.app_handle().clone();
    let _ = win.with_webview(move |pw| {
        let app = app.clone();
        pw.inner().connect_web_process_terminated(move |view, reason| {
            let why = match reason {
                WebProcessTerminationReason::ExceededMemoryLimit => "ran out of memory",
                _ => "crashed",
            };
            eprintln!("clovereye post helper: the site page {why}; reloading it");
            fail_pending(&app, &format!("The site page {why} in CloverEye's helper window. It has been reloaded: press New captcha to try again."));
            view.reload();
        });
    });
}

#[cfg(not(target_os = "linux"))]
fn watch_crashes(_win: &tauri::WebviewWindow) {}

/// The one command the helper page may call (capabilities/post-agent.json):
/// "ready" when a board page has loaded, "show" when the site wants its human
/// check, "log" for the terminal, or the answer to a request.
#[tauri::command]
pub fn post_agent_reply(webview: tauri::Webview, id: String, ok: bool, data: Value) -> Result<(), String> {
    if webview.label() != AGENT_LABEL {
        return Err("not the post helper".into());
    }
    let state = webview.app_handle().state::<AgentState>();
    if id == "ready" {
        state.ready.store(true, Ordering::SeqCst);
        state.ready_notify.notify_waiters();
        if let Some(w) = webview.app_handle().get_webview_window(AGENT_LABEL) {
            let _ = w.hide(); // a passed check: back out of sight
        }
        return Ok(());
    }
    if id == "waiting" {
        // The captcha page, waiting on the site's check: it takes requests
        // (a newer captcha request) but stays in view.
        state.ready.store(true, Ordering::SeqCst);
        state.ready_notify.notify_waiters();
        return Ok(());
    }
    if id == "log" {
        // What the helper saw, for the terminal (no page content).
        eprintln!("clovereye post helper: {}", data.as_str().unwrap_or_default());
        return Ok(());
    }
    let window = webview.app_handle().get_webview_window(AGENT_LABEL);
    if id == "show" {
        // The site put its human check in front of the captcha: let the
        // person see it and pass it.
        if let Some(w) = window {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        return Ok(());
    }
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        if let Some(w) = window {
            let _ = w.hide(); // answered: back out of sight
        }
        let _ = tx.send(if ok { Ok(data) } else { Err(data.as_str().unwrap_or("The helper failed.").to_string()) });
    }
    Ok(())
}

/// Opens another CloverEye window with its own panes. `panes` is the URL
/// fragment the UI wrote (encodeURIComponent of a short JSON list).
#[tauri::command]
pub async fn open_window(app: tauri::AppHandle, panes: String) -> Result<String, String> {
    if panes.len() > 8192 || !panes.bytes().all(|c| c.is_ascii_alphanumeric() || b"%._~-*'()!".contains(&c)) {
        return Err("bad window contents".into());
    }
    let n = app.state::<AgentState>().windows.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("w-{n}");
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(format!("index.html#panes={panes}").into()))
        .title("CloverEye")
        .inner_size(1180.0, 820.0)
        .min_inner_size(640.0, 480.0);
    // macOS: the same native traffic lights over the drawn title bar as the
    // main window (tauri.macos.conf.json); the UI hides its drawn buttons there.
    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(14.0, 21.0));
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    builder.build().map_err(|e| e.to_string())?;
    Ok(label)
}

/// Only files from the site's image host, by board and file number.
pub fn media_url_ok(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://i.4cdn.org/") else { return false };
    let mut parts = rest.split('/');
    let (Some(board), Some(file), None) = (parts.next(), parts.next(), parts.next()) else { return false };
    let Some((stem, ext)) = file.rsplit_once('.') else { return false };
    clovereye_fetch::valid_board(board)
        && (8..=20).contains(&stem.len())
        && stem.bytes().all(|c| c.is_ascii_digit())
        && ["jpg", "png", "gif", "webm", "mp4", "pdf"].contains(&ext)
}

/// A file name safe on every desktop: no separators or control characters.
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    let mut s = if trimmed.is_empty() { "file".to_string() } else { trimmed };
    if s.len() > 150 {
        let mut cut = 150;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
    }
    s
}

/// `name`, or `name-2`, `name-3`... so a save never overwrites a file.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.to_string(), String::new()),
    };
    (2..10_000)
        .map(|i| dir.join(format!("{stem}-{i}{ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// Saves one file from the image host into the download folder (Settings →
/// Files, else the system Downloads folder/CloverEye). One request, made
/// because the person asked for it.
#[tauri::command]
pub async fn save_media(app: tauri::AppHandle, url: String, name: String, dir: Option<String>) -> Result<String, String> {
    if !media_url_ok(&url) {
        return Err("Only files from the image host can be saved.".into());
    }
    let folder = match dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) if Path::new(d).is_absolute() => PathBuf::from(d),
        _ => app.path().download_dir().map_err(|e| e.to_string())?.join("CloverEye"),
    };
    let name = safe_name(&name);
    // Through the download gate every file download in the app shares:
    // at least 1 s apart, also while Download all or Save offline runs.
    crate::offline::gated(&app, move || {
        std::fs::create_dir_all(&folder).map_err(|e| format!("creating {}: {e}", folder.display()))?;
        let body = match crate::offline::download(&url) {
            Err(e) if e == "not-found" => return Err("The file is gone from the site.".into()),
            other => other?,
        };
        let path = unique_path(&folder, &name);
        crate::offline::write_atomic(&path, &body)?;
        Ok(path.display().to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_image_host_files_are_saved() {
        assert!(media_url_ok("https://i.4cdn.org/g/1793731659876000.webm"));
        assert!(media_url_ok("https://i.4cdn.org/wsg/1793731659876000.mp4"));
        assert!(!media_url_ok("http://i.4cdn.org/g/1793731659876000.jpg"));
        assert!(!media_url_ok("https://i.4cdn.org/g/../etc/passwd"));
        assert!(!media_url_ok("https://i.4cdn.org/g/1793731659876000.exe"));
        assert!(!media_url_ok("https://evil.example/g/1793731659876000.jpg"));
        assert!(!media_url_ok("https://i.4cdn.org/G/1793731659876000.jpg"));
        assert!(!media_url_ok("https://i.4cdn.org/g/x/1793731659876000.jpg"));
    }

    #[test]
    fn names_are_safe_and_unique() {
        assert_eq!(safe_name("a/b\\c:d*?.png"), "a_b_c_d__.png");
        assert_eq!(safe_name("  ..  "), "file");
        assert_eq!(safe_name(&"é".repeat(200)).len() <= 150, true);
        let dir = std::env::temp_dir().join(format!("ce-unique-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("x.png"), b"1").unwrap();
        std::fs::write(dir.join("x-2.png"), b"1").unwrap();
        assert_eq!(unique_path(&dir, "x.png"), dir.join("x-3.png"));
        assert_eq!(unique_path(&dir, "y.png"), dir.join("y.png"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
