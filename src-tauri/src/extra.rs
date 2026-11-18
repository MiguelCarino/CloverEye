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
    let t0 = std::time::Instant::now();
    let board = board_of(&args)?;
    let thread = args.get("thread").and_then(Value::as_u64).unwrap_or(0);
    if op == "post" {
        // what is sent, by size only: never the fields' text or the file's name
        let fields = args.get("fields").and_then(Value::as_object).map_or(0, |o| o.len());
        let file_bytes = args.pointer("/file/b64").and_then(Value::as_str).map_or(0, |b| b.len() / 4 * 3);
        log_info!("post", "post requested", board = board, fields = fields, file_bytes = file_bytes);
    } else {
        log_info!("post", "captcha requested", board = board, thread = thread);
    }
    let result = run_agent(&app, &op, &board, args, t0).await;
    match &result {
        Ok(v) => {
            // the answer's keys only (challenge, img, ttl...), never its values
            let keys = v.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>().join(",")).unwrap_or_default();
            let status = v.get("status").and_then(Value::as_u64).unwrap_or(0);
            log_info!("post", "helper answered", op = op, board = board, keys = keys, status = status, ms = crate::diag::ms(t0));
        }
        Err(e) if e == "check-needed" => log_info!("post", "the site wants its check first; showing the helper window", op = op, board = board, ms = crate::diag::ms(t0)),
        Err(e) => log_warn!("post", "helper request failed", op = op, board = board, error = e.chars().take(200).collect::<String>(), ms = crate::diag::ms(t0)),
    }
    result
}

/// One helper request (post_agent): waits for the helper page, hands it the
/// request and waits for its answer.
async fn run_agent(app: &tauri::AppHandle, op: &str, board: &str, args: Value, t0: std::time::Instant) -> Result<Value, String> {
    let fresh = app.get_webview_window(AGENT_LABEL).is_none();
    let win = ensure_agent(app, board)?;
    let state = app.state::<AgentState>();
    if !wait_ready(&state, Duration::from_secs(20)).await {
        let _ = win.show();
        let _ = win.set_focus();
        return Err("check-needed".into());
    }
    let id = state.counter.fetch_add(1, Ordering::SeqCst).to_string();
    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(id.clone(), tx);
    log_info!("post", "helper request", id = id, op = op, new_window = fresh, ready_ms = crate::diag::ms(t0));
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
            log_info!("post", "no captcha yet; showing the helper window", id = id, after_s = SHOW_AFTER_SECS);
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
        limit -= first;
    }
    match tokio::time::timeout(limit, rx).await {
        Ok(Ok(result)) => result,
        _ => {
            log_warn!("post", "the helper did not answer in time", id = id, op = op, limit_s = limit.as_secs());
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

/// Reloads of a crashed helper page allowed within `RELOAD_WINDOW`; a page
/// that crashes more often than that is not reloaded into the same crash.
const RELOADS_ALLOWED: usize = 2;
const RELOAD_WINDOW: Duration = Duration::from_secs(60);

/// Whether one more reload fits: `recent` holds the times of earlier
/// reloads, and is trimmed to the window and, if it fits, given `now`.
fn reload_allowed(recent: &mut Vec<std::time::Instant>, now: std::time::Instant) -> bool {
    recent.retain(|t| now.saturating_duration_since(*t) < RELOAD_WINDOW);
    if recent.len() >= RELOADS_ALLOWED {
        return false;
    }
    recent.push(now);
    true
}

/// When the helper's web page dies (WebKit's web process crashed or was
/// killed), whatever it was doing ends with a reason, and the page reloads,
/// at most twice a minute: after that the helper window is closed, and the
/// next request opens a fresh one.
/// It also keeps, from WebKit's side, how every load of the site's captcha
/// and its checks (spur.us, mcl.io, Cloudflare) ended: the HTTP status, or
/// the network error. That goes in the diagnostics report (diag.rs), and to
/// the terminal with CLOVEREYE_HELPER_DEBUG=1.
#[cfg(target_os = "linux")]
fn watch_crashes(win: &tauri::WebviewWindow) {
    use webkit2gtk::{WebProcessTerminationReason, WebViewExt};
    let app = win.app_handle().clone();
    let _ = win.with_webview(move |pw| {
        log_check_loads(&pw.inner());
        let app = app.clone();
        let recent = Mutex::new(Vec::new());
        pw.inner().connect_web_process_terminated(move |view, reason| {
            let why = match reason {
                WebProcessTerminationReason::ExceededMemoryLimit => "ran out of memory",
                _ => "crashed",
            };
            if reload_allowed(&mut recent.lock().unwrap(), std::time::Instant::now()) {
                log_warn!("post", "the helper's site page died; reloading it", why = why);
                fail_pending(&app, &format!("The site page {why} in CloverEye's helper window. It has been reloaded: press New captcha to try again."));
                view.reload();
                return;
            }
            log_warn!("post", "the helper's site page died again; closing the helper window", why = why);
            fail_pending(&app, &format!("The site page {why} again in CloverEye's helper window, so the window was closed. Press New captcha to open a fresh one."));
            // Not from inside WebKit's own signal: on the next turn.
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(w) = app.get_webview_window(AGENT_LABEL) {
                    let _ = w.destroy();
                }
            });
        });
    });
}

/// Where a captcha or check load went, for the log: its host and at most
/// its first two path segments. The rest of a challenge path carries
/// tokens, ids and site keys ("/cdn-cgi/challenge-platform/h/b/flow/ov1/
/// 1384893571:...:Q2Zh.../"), and so can a segment: one that is long, odd
/// or mixes letters and digits reads "(id)".
pub(crate) fn check_load_place(uri: &str) -> (String, String) {
    let rest = uri.split(['?', '#']).next().unwrap_or_default();
    let rest = rest.split_once("://").map_or(rest, |(_, r)| r);
    let mut parts = rest.split('/');
    let host: String = parts.next().unwrap_or_default().chars().take(64).collect();
    let plain = |seg: &str| {
        seg.len() <= 24 && seg.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c)) && (seg.len() <= 8 || !seg.bytes().any(|c| c.is_ascii_digit()))
    };
    let segs: Vec<&str> = parts.filter(|p| !p.is_empty()).take(2).map(|p| if plain(p) { p } else { "(id)" }).collect();
    (host, format!("/{}", segs.join("/")))
}

/// How each load of the captcha and its checks ended, for the diagnostics
/// report: failures and refusals at the default level, the rest with
/// Detailed logs on (a captcha makes many). Never the whole address.
#[cfg(target_os = "linux")]
fn log_check_loads(view: &webkit2gtk::WebView) {
    use webkit2gtk::{URIRequestExt, URIResponseExt, WebResourceExt, WebViewExt};
    view.connect_resource_load_started(|_view, res, req| {
        let uri = req.uri().map(|u| u.to_string()).unwrap_or_default();
        let host = uri.split('/').nth(2).unwrap_or_default().to_string();
        let watched = ["spur.us", "mcl.io", "sys.4chan.org", "cloudflare.com"].iter().any(|h| host == *h || host.ends_with(&format!(".{h}")));
        if !watched {
            return;
        }
        let (host, path) = check_load_place(&uri);
        let (h1, p1) = (host.clone(), path.clone());
        // WebKit sends "finished" after "failed" too: one line per load.
        let failed = std::rc::Rc::new(std::cell::Cell::new(false));
        let f1 = failed.clone();
        res.connect_finished(move |r| {
            if f1.get() {
                return;
            }
            let status = r.response().map(|x| x.status_code()).unwrap_or(0);
            if (200..400).contains(&status) {
                log_debug!("post", "check load", host = h1, path = p1, status = status);
            } else {
                log_info!("post", "check load", host = h1, path = p1, status = status);
            }
        });
        res.connect_failed(move |r, e| {
            failed.set(true);
            let status = r.response().map(|x| x.status_code()).unwrap_or(0);
            log_info!("post", "check load FAILED", host = host, path = path, status = status, error = e);
        });
    });
}

#[cfg(not(target_os = "linux"))]
fn watch_crashes(_win: &tauri::WebviewWindow) {}

/// The mouse's back and forward side buttons. WebKitGTK does not pass them
/// to the page (X buttons 8 and 9 reach GTK, but no DOM event follows), so
/// they are caught on the web view and handed to the UI's own back and
/// forward (shell.js, window.__cloverEyeNav), in the pane under the
/// pointer. WebView2 (Windows) gives the page DOM buttons 3 and 4 itself.
#[cfg(target_os = "linux")]
pub fn side_buttons(win: &tauri::WebviewWindow) {
    let _ = win.with_webview(|wv| {
        use gtk::prelude::WidgetExt;
        use webkit2gtk::WebViewExt;
        let view = wv.inner();
        view.connect_button_press_event(|v, ev| {
            let dir = match ev.button() {
                8 => "back",
                9 => "forward",
                _ => return gtk::glib::Propagation::Proceed,
            };
            // run_javascript: deprecated since 2.40 for evaluate_javascript,
            // which this crate offers only behind a newer feature; works on
            // every WebKitGTK the packages use (2.50 to 2.54)
            #[allow(deprecated)]
            v.run_javascript(&format!("window.__cloverEyeNav && window.__cloverEyeNav('{dir}')"), None::<&gtk::gio::Cancellable>, |_| {});
            gtk::glib::Propagation::Stop
        });
    });
}

#[cfg(not(target_os = "linux"))]
pub fn side_buttons(_win: &tauri::WebviewWindow) {}

/// Helper lines kept a minute at most.
const HELPER_PER_MIN: u32 = 60;
static HELPER_GATE: std::sync::Mutex<crate::diag::MinuteGate> = std::sync::Mutex::new(crate::diag::MinuteGate::new());

/// A line from the helper page (post_agent.js `log(...)`), when it is one
/// the helper sends: the start of each is fixed, and what follows is a
/// path, a page title, a list of keys or the site's error, kept short.
pub(crate) fn helper_line(line: &str) -> Option<String> {
    const KNOWN: [&str; 9] = [
        "captcha arrived (own page): ",
        "captcha arrived (frame): ",
        "captcha page is waiting (the site check?): ",
        "captcha page opened: ",
        "captcha frame loaded",
        "captcha frame silent",
        "captcha frame answered an error: ",
        "post answered ",
        "page ready: ",
    ];
    let line = line.trim();
    let start = KNOWN.iter().find(|k| line.starts_with(**k))?;
    let rest: String = line[start.len()..].chars().filter(|c| !c.is_control()).take(120).collect();
    Some(format!("{start}{rest}"))
}

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
        log_debug!("post", "helper page ready");
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
        log_debug!("post", "helper page waiting on the site's check");
        state.ready.store(true, Ordering::SeqCst);
        state.ready_notify.notify_waiters();
        return Ok(());
    }
    if id == "log" {
        // What the helper saw, for the terminal (no page content).
        let line = data.as_str().unwrap_or_default();
        if line.starts_with("debug:") || line.starts_with("frame:") {
            // debug mode only: these carry page text and whole addresses, so
            // they stay out of the log file and the diagnostics report
            eprintln!("clovereye post helper: {line}");
            return Ok(());
        }
        // The helper runs on the site's pages, so any script there can call
        // this: only the helper's own lines are kept, at most HELPER_PER_MIN.
        let (keep, late) = HELPER_GATE.lock().unwrap_or_else(|e| e.into_inner()).admit(crate::diag::minute_now(), HELPER_PER_MIN, "", false);
        if let Some(n) = late {
            log_warn!("post", "helper lines not kept (past the per-minute cap)", n = n);
        }
        if keep {
            match helper_line(line) {
                Some(l) => log_info!("post", l),
                None => log_debug!("post", "helper sent a line it does not send", chars = line.chars().count()),
            }
        }
        return Ok(());
    }
    let window = webview.app_handle().get_webview_window(AGENT_LABEL);
    if id == "show" {
        // The site put its human check in front of the captcha: let the
        // person see it and pass it.
        log_info!("post", "the site showed its human check; helper window shown");
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
    let win = builder.build().map_err(|e| {
        log_error!("app", "a new window could not open", error = e);
        e.to_string()
    })?;
    side_buttons(&win);
    let open = app.webview_windows().keys().filter(|l| *l == "main" || l.starts_with("w-")).count();
    log_info!("app", "window opened", win = label, panes_chars = panes.len(), windows = open);
    Ok(label)
}

/// The extension of a file on the image host ("jpg", "webm"...), from its
/// checked address: the server's own, never the uploader's file name. None
/// for any other address: only files from the site's image host, by board
/// and file number, are saved.
pub fn media_ext(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("https://i.4cdn.org/")?;
    let mut parts = rest.split('/');
    let (Some(board), Some(file), None) = (parts.next(), parts.next(), parts.next()) else { return None };
    let (stem, ext) = file.rsplit_once('.')?;
    (clovereye_fetch::valid_board(board)
        && (8..=20).contains(&stem.len())
        && stem.bytes().all(|c| c.is_ascii_digit())
        && ["jpg", "png", "gif", "webm", "mp4", "pdf"].contains(&ext))
    .then_some(ext)
}

/// Longest file name kept, in bytes.
const NAME_BYTES: usize = 150;

/// A dot or any whitespace: never kept at either end of a file name.
fn name_edge(c: char) -> bool {
    c == '.' || c.is_whitespace()
}

/// `s` cut to at most `max` bytes on a character boundary, with no
/// trailing dots or whitespace (Windows drops them, changing the name).
fn cut_bytes(s: &str, max: usize) -> &str {
    let mut cut = s.len().min(max);
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s[..cut].trim_end_matches(name_edge)
}

/// A file name safe on every desktop: no separators or control characters,
/// at most 150 bytes. A longer name is cut in its stem, so an extension of
/// up to five letters or digits stays on the end. A name of 150 bytes or
/// less is only cleaned, and the result is the same when cleaned again.
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim_matches(name_edge).to_string();
    let s = if trimmed.is_empty() { "file".to_string() } else { trimmed };
    if s.len() <= NAME_BYTES {
        return s;
    }
    match s.rsplit_once('.') {
        Some((stem, ext)) if (1..=5).contains(&ext.len()) && ext.bytes().all(|c| c.is_ascii_alphanumeric()) && !stem.is_empty() => {
            format!("{}.{ext}", cut_bytes(stem, NAME_BYTES - 1 - ext.len()))
        }
        _ => cut_bytes(&s, NAME_BYTES).to_string(),
    }
}

/// The name to save a file from the image host under: the person's (the
/// uploader's) name, cleaned and cut in its stem, always ending in the
/// server's own extension `ext`. "x.hta.zzz" saved from a .jpg is
/// "x.hta.zzz.jpg", never "x.hta".
pub fn save_name(name: &str, ext: &str) -> String {
    let n = safe_name(name);
    let stem = match n.rsplit_once('.') {
        Some((stem, tail)) if tail.eq_ignore_ascii_case(ext) => stem,
        _ => n.as_str(),
    };
    let stem = cut_bytes(stem.trim_end_matches(name_edge), NAME_BYTES - 1 - ext.len());
    let stem = if stem.is_empty() { "file" } else { stem };
    format!("{stem}.{ext}")
}

/// The names offline::write_new tries, in order: `name`, then
/// `name-2` ... `name-9999`, then names with the time and a count in them.
pub(crate) fn name_candidates(name: &str) -> impl Iterator<Item = String> + '_ {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    let ext2 = ext.clone();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::iter::once(name.to_string())
        .chain((2..10_000).map(move |i| format!("{stem}-{i}{ext}")))
        .chain((0u64..).map(move |i| format!("{stem}-{nanos}-{i}{ext2}")))
}

/// Saves one file from the image host into the download folder (Settings →
/// Files, else the system Downloads folder/CloverEye). One request, made
/// because the person asked for it.
#[tauri::command]
pub async fn save_media(app: tauri::AppHandle, url: String, name: String, dir: Option<String>) -> Result<String, String> {
    let Some(ext) = media_ext(&url) else {
        return Err("Only files from the image host can be saved.".into());
    };
    let folder = match dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) if Path::new(d).is_absolute() => PathBuf::from(d),
        _ => app.path().download_dir().map_err(|e| e.to_string())?.join("CloverEye"),
    };
    // The server's extension, never one from the uploader's name.
    let name = save_name(&name, ext);
    // Through the download gate every file download in the app shares:
    // at least 1 s apart, also while Download all or Save offline runs.
    let t0 = std::time::Instant::now();
    let hide = [folder.display().to_string(), name.clone()];
    let ext = ext.to_string();
    let ext_in = ext.clone();
    let out = crate::offline::gated(&app, move || {
        std::fs::create_dir_all(&folder).map_err(|e| format!("creating {}: {e}", folder.display()))?;
        let body = match crate::offline::download(&url) {
            Err(e) if e == "not-found" => return Err("The file is gone from the site.".into()),
            other => other?,
        };
        let path = crate::offline::write_new(&folder, &name, &body)?;
        log_info!("files", "file saved", ext = ext_in, bytes = body.len(), ms = crate::diag::ms(t0));
        Ok(path.display().to_string())
    })
    .await;
    if let Err(e) = &out {
        log_warn!("files", "file not saved", ext = ext, error = crate::diag::redact(e, &hide), ms = crate::diag::ms(t0));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media_url_ok(url: &str) -> bool {
        media_ext(url).is_some()
    }

    #[test]
    fn check_loads_keep_the_host_and_never_a_token() {
        let (h, p) = check_load_place("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/flow/ov1/1384893571:1731830000:Q2Zh3xYk9LmPq7RtWv1Bz5Nc8Dd0Ee2Ff4Gg6Hh8Ii/8e3f2a1b9c7d4e5f/AbCdEf0123456789xyZ");
        assert_eq!((h.as_str(), p.as_str()), ("challenges.cloudflare.com", "/cdn-cgi/challenge-platform"));
        let (_, p) = check_load_place("https://challenges.cloudflare.com/turnstile/0x4AAAAAAAabcdefGHIJ/light?x=1");
        assert_eq!(p, "/turnstile/(id)");
        let (h, p) = check_load_place("https://sys.4chan.org/captcha?framed=1&board=g&ticket=abc");
        assert_eq!((h.as_str(), p.as_str()), ("sys.4chan.org", "/captcha"));
        let (_, p) = check_load_place("https://spur.us/d/8e3f2a1b9c7d4e5f9a/x");
        assert_eq!(p, "/d/(id)");
        assert_eq!(check_load_place("https://mcl.io/").1, "/");
    }

    #[test]
    fn only_the_helpers_own_lines_reach_the_log() {
        assert_eq!(helper_line("post answered 200").as_deref(), Some("post answered 200"));
        assert_eq!(helper_line("captcha page opened: /captcha").as_deref(), Some("captcha page opened: /captcha"));
        assert_eq!(helper_line("captcha frame silent: opening the captcha page itself").as_deref(), Some("captcha frame silent: opening the captcha page itself"));
        assert_eq!(helper_line("my secret reply text"), None);
        assert_eq!(helper_line("anything at all from a page script"), None);
        let long = format!("page ready: {}", "x".repeat(500));
        assert_eq!(helper_line(&long).unwrap().chars().count(), "page ready: ".len() + 120);
    }

    #[test]
    fn a_crashing_helper_page_is_reloaded_at_most_twice_a_minute() {
        let t0 = std::time::Instant::now();
        let mut recent = Vec::new();
        assert!(reload_allowed(&mut recent, t0));
        assert!(reload_allowed(&mut recent, t0 + Duration::from_secs(5)));
        assert!(!reload_allowed(&mut recent, t0 + Duration::from_secs(10)));
        assert!(!reload_allowed(&mut recent, t0 + Duration::from_secs(59)));
        // the first reload has left the window
        assert!(reload_allowed(&mut recent, t0 + Duration::from_secs(61)));
        assert!(!reload_allowed(&mut recent, t0 + Duration::from_secs(62)));
        assert!(reload_allowed(&mut recent, t0 + Duration::from_secs(200)));
    }

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
    fn names_are_safe() {
        assert_eq!(safe_name("a/b\\c:d*?.png"), "a_b_c_d__.png");
        assert_eq!(safe_name("  ..  "), "file");
        assert!(safe_name(&"é".repeat(200)).len() <= 150);
    }

    #[test]
    fn taken_names_get_a_number_then_the_time() {
        // offline::write_new tries these in order (its tests check that a
        // file or link already there is never written through)
        let mut c = name_candidates("x.png");
        assert_eq!(c.next().as_deref(), Some("x.png"));
        assert_eq!(c.next().as_deref(), Some("x-2.png"));
        let late = name_candidates("x.png").nth(9_999).unwrap();
        assert!(late.starts_with("x-") && late.ends_with(".png") && late != "x-9999.png", "{late}");
        let mut no_ext = name_candidates("README");
        assert_eq!(no_ext.nth(1).as_deref(), Some("README-2"));
        assert_eq!(name_candidates(".png").nth(1).as_deref(), Some(".png-2"));
    }

    #[test]
    fn the_extension_comes_from_the_address() {
        assert_eq!(media_ext("https://i.4cdn.org/g/1793731659876000.webm"), Some("webm"));
        assert_eq!(media_ext("https://i.4cdn.org/g/1793731659876000.exe"), None);
        assert_eq!(media_ext("https://evil.example/g/1793731659876000.jpg"), None);
    }

    #[test]
    fn long_names_are_cut_in_the_stem_and_keep_their_extension() {
        // 51 CJK characters (153 bytes) + .jpg: the extension stays
        let cjk = format!("{}.jpg", "日".repeat(51));
        let n = safe_name(&cjk);
        assert!(n.len() <= 150 && n.ends_with(".jpg"), "{n}");
        assert!(n.starts_with("日日日"));
        // a long tail that is not an extension is cut like any text
        let n = safe_name(&format!("a.{}", "z".repeat(200)));
        assert_eq!(n.len(), 150);
        // names of 150 bytes or less are only cleaned
        let short = format!("{}.png", "b".repeat(146));
        assert_eq!(safe_name(&short), short);
        // a cut never leaves a trailing dot or space
        let n = safe_name(&format!("{}{}.jpg", "c".repeat(140), " .".repeat(20)));
        assert!(n.ends_with("c.jpg"), "{n}");
    }

    #[test]
    fn safe_name_is_the_same_when_run_again() {
        for name in [
            format!("{}.jpg", "日".repeat(60)),
            format!("{}.hta{}", "A".repeat(116), "z".repeat(40)),
            "a/b\\c:d*?.png".to_string(),
            "  ..  ".to_string(),
            format!("x.{}", "é".repeat(120)),
            // a cut that ends on wide or no-break space, and dots and
            // spaces mixed at the ends
            format!("{}\u{3000}{}", "a".repeat(147), "b".repeat(10)),
            format!("{}\u{a0}{}.png", "a".repeat(145), "b".repeat(10)),
            ". x . ".to_string(),
            "\u{3000}.cat.jpg.\u{a0}".to_string(),
        ] {
            let once = safe_name(&name);
            assert_eq!(safe_name(&once), once, "{name}");
        }
    }

    #[test]
    fn saved_files_always_end_in_the_servers_extension() {
        // the uploader's name hides .hta past the cut: still saved as .jpg
        let sly = format!("{}.hta{}", "A".repeat(116), "z".repeat(40));
        let n = save_name(&format!("{sly}.jpg"), "jpg");
        assert!(n.ends_with(".jpg") && n.len() <= 150, "{n}");
        let n = save_name(&format!("{}.hta", "A".repeat(116)), "jpg");
        assert!(n.ends_with(".hta.jpg"), "{n}");
        // the right extension is not doubled; case is the server's
        assert_eq!(save_name("cat.jpg", "jpg"), "cat.jpg");
        assert_eq!(save_name("cat.JPG", "jpg"), "cat.jpg");
        // a wrong or missing one gets the real one added
        assert_eq!(save_name("cat.png", "jpg"), "cat.png.jpg");
        assert_eq!(save_name("v1.2", "webm"), "v1.2.webm");
        assert_eq!(save_name("", "gif"), "file.gif");
        assert_eq!(save_name("...", "pdf"), "file.pdf");
        // 60 CJK characters + .jpg keeps .jpg (the library can take it)
        let n = save_name(&format!("{}.jpg", "日".repeat(60)), "jpg");
        assert!(n.ends_with(".jpg") && n.len() <= 150, "{n}");
        assert_eq!(safe_name(&n), n, "a saved name passes safe_name unchanged");
    }
}
