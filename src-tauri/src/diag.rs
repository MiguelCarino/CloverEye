// Diagnostics: what to attach to a bug report, without a terminal.
//
// Every line the post helper prints also goes to an in-memory log (the last
// MAX_LINES) and to clovereye.log in the app's log folder; the log of the
// session before is kept as clovereye.old.log, for a crash. Settings ›
// Diagnostics turns it into one text file: versions, the WebKit switches,
// recent web process crash dumps (Linux) and this session's log. It holds
// no posts, captcha answers, cookies or tokens: addresses are cut at the
// query, and the home folder reads as ~.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::Manager;

const MAX_LINES: usize = 3000;
/// The log file stops growing here (a long session with debug on).
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const LOG_FILE: &str = "clovereye.log";
const OLD_LOG_FILE: &str = "clovereye.old.log";

struct Log {
    lines: VecDeque<String>,
    file: Option<File>,
    written: u64,
}

static LOG: Mutex<Log> = Mutex::new(Log { lines: VecDeque::new(), file: None, written: 0 });
/// CloverEye turned WebKit's DMA-BUF renderer off itself (main.rs).
pub static DMABUF_GUARD_SET: AtomicBool = AtomicBool::new(false);

/// UTC "2026-11-11 21:46:12" for a Unix time (no date crate needed).
fn utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Keeps a line for the report; the terminal gets it only when `print`.
fn keep(line: &str, print: bool) {
    if print {
        eprintln!("clovereye {line}");
    }
    let stamped = format!("{} {}", utc(now_secs()), line.replace(['\r', '\n'], " "));
    let mut log = LOG.lock().unwrap_or_else(|e| e.into_inner());
    if log.written < MAX_FILE_BYTES {
        let bytes = stamped.len() as u64 + 1;
        if let Some(f) = log.file.as_mut() {
            if writeln!(f, "{stamped}").is_ok() {
                log.written += bytes;
            }
        }
    }
    if log.lines.len() >= MAX_LINES {
        log.lines.pop_front();
    }
    log.lines.push_back(stamped);
}

/// A line for the terminal and the report ("post helper: ...").
pub fn note(line: &str) {
    keep(line, true);
}

/// A line for the report only (the terminal sees it with debug on).
pub fn quiet(line: &str, print: bool) {
    keep(line, print);
}

/// Opens the log file (the last session's becomes clovereye.old.log) and
/// writes the lines kept before it was open.
pub fn init(app: &tauri::AppHandle) {
    let Ok(dir) = app.path().app_log_dir() else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join(LOG_FILE);
    let _ = std::fs::rename(&path, dir.join(OLD_LOG_FILE));
    let Ok(mut f) = OpenOptions::new().create(true).write(true).truncate(true).open(&path) else { return };
    let mut log = LOG.lock().unwrap_or_else(|e| e.into_inner());
    let mut written = 0;
    for l in &log.lines {
        if writeln!(f, "{l}").is_ok() {
            written += l.len() as u64 + 1;
        }
    }
    log.file = Some(f);
    log.written = written;
}

fn home() -> Option<String> {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok().filter(|h| h.len() > 1)
}

/// The home folder as ~, so the report does not carry the account name.
fn tidy(text: &str) -> String {
    match home() {
        Some(h) => text.replace(&h, "~"),
        None => text.to_string(),
    }
}

#[cfg(target_os = "linux")]
fn os_name() -> String {
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|t| {
            t.lines()
                .find_map(|l| l.strip_prefix("PRETTY_NAME="))
                .map(|v| v.trim_matches('"').to_string())
        })
        .unwrap_or_else(|| "Linux".into())
}

#[cfg(not(target_os = "linux"))]
fn os_name() -> String {
    std::env::consts::OS.to_string()
}

fn packaging() -> &'static str {
    if std::env::var_os("APPIMAGE").is_some() {
        return "AppImage";
    }
    let exe = std::env::current_exe().unwrap_or_default();
    if exe.starts_with("/usr") {
        "system package"
    } else if cfg!(target_os = "macos") && exe.to_string_lossy().contains(".app/") {
        "app bundle"
    } else if cfg!(windows) {
        "installer"
    } else {
        "other (built or unpacked)"
    }
}

#[cfg(target_os = "linux")]
fn webkit_lines(out: &mut String) {
    use webkit2gtk::ffi;
    let (a, b, c) = unsafe { (ffi::webkit_get_major_version(), ffi::webkit_get_minor_version(), ffi::webkit_get_micro_version()) };
    out.push_str(&format!("WebKitGTK: {a}.{b}.{c}\n"));
    let dmabuf = match std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER") {
        Ok(_) if DMABUF_GUARD_SET.load(Ordering::SeqCst) => "off (CloverEye: this WebKitGTK is older than 2.54.1)".to_string(),
        Ok(v) => format!("off (WEBKIT_DISABLE_DMABUF_RENDERER={v} set outside CloverEye)"),
        Err(_) => "on".to_string(),
    };
    out.push_str(&format!("DMA-BUF renderer: {dmabuf}\n"));
    let hw = match std::env::var("GST_PLUGIN_FEATURE_RANK") {
        Ok(v) if v.contains("nvvp9dec:NONE") && std::env::var_os("CLOVEREYE_HW_VIDEO").is_none() => "NVIDIA decoders off (CloverEye; CLOVEREYE_HW_VIDEO=1 keeps them)".to_string(),
        Ok(v) => format!("GST_PLUGIN_FEATURE_RANK={} (set outside CloverEye)", v.chars().take(120).collect::<String>()),
        Err(_) => "GStreamer's own choice".to_string(),
    };
    out.push_str(&format!("Video decoders: {hw}\n"));
}

#[cfg(not(target_os = "linux"))]
fn webkit_lines(_out: &mut String) {}

/// Runs a read-only command for at most `limit`; its output, or None.
#[cfg(target_os = "linux")]
fn run_for(cmd: &str, args: &[&str], limit: Duration) -> Option<String> {
    use std::process::{Command, Stdio};
    let mut child = Command::new(cmd).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().ok()?;
    let deadline = std::time::Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let out = child.wait_with_output().ok()?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Some(text)
}

/// The last WebKit web process crash dumps systemd kept (none, or no
/// systemd-coredump: says so).
#[cfg(target_os = "linux")]
fn crash_dumps(out: &mut String) {
    out.push_str("\n== WebKit web process crash dumps (coredumpctl, newest first)\n");
    match run_for("coredumpctl", &["list", "--no-pager", "-r", "-n", "8", "WebKitWebProcess"], Duration::from_secs(5)) {
        Some(t) if !t.trim().is_empty() => out.push_str(t.trim_end()),
        Some(_) => out.push_str("none"),
        None => out.push_str("coredumpctl is not available"),
    }
    out.push('\n');
}

#[cfg(not(target_os = "linux"))]
fn crash_dumps(_out: &mut String) {}

/// CloverEye's and WebKit's switches that change how the helper behaves.
fn switches() -> Vec<String> {
    let mut on: Vec<String> = std::env::vars()
        .filter(|(k, _)| k.starts_with("CLOVEREYE_") || k.starts_with("WEBKIT_") || k == "GDK_BACKEND" || k == "LIBGL_ALWAYS_SOFTWARE")
        .map(|(k, v)| {
            // values could be paths (CLOVEREYE_TRY_CAPTCHA_FILE): short ones only
            if v.len() <= 16 && !v.contains('/') && !v.contains('\\') {
                format!("{k}={v}")
            } else {
                format!("{k}=(set)")
            }
        })
        .collect();
    on.sort();
    on
}

pub fn report(app: &tauri::AppHandle) -> String {
    let mut out = String::new();
    out.push_str("CloverEye diagnostics\n");
    out.push_str(&format!("Made: {} UTC\n", utc(now_secs())));
    out.push_str(&format!("CloverEye: {} ({})\n", app.package_info().version, packaging()));
    out.push_str(&format!("System: {} ({})\n", os_name(), std::env::consts::ARCH));
    if let Ok(s) = std::env::var("XDG_SESSION_TYPE") {
        let desk = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
        out.push_str(&format!("Session: {s} {desk}\n"));
    }
    webkit_lines(&mut out);
    let sw = switches();
    out.push_str(&format!("Switches: {}\n", if sw.is_empty() { "none".into() } else { sw.join(" ") }));
    crash_dumps(&mut out);
    out.push_str("\n== This session's log\n");
    let log = LOG.lock().unwrap_or_else(|e| e.into_inner());
    if log.lines.is_empty() {
        out.push_str("(nothing logged yet)\n");
    }
    for l in &log.lines {
        out.push_str(l);
        out.push('\n');
    }
    drop(log);
    if let Ok(dir) = app.path().app_log_dir() {
        let old = dir.join(OLD_LOG_FILE);
        if let Ok(t) = std::fs::read_to_string(&old) {
            out.push_str("\n== The session before (clovereye.old.log, last 300 lines)\n");
            let lines: Vec<&str> = t.lines().collect();
            for l in &lines[lines.len().saturating_sub(300)..] {
                out.push_str(l);
                out.push('\n');
            }
        }
    }
    tidy(&out)
}

/// The report as text, for Copy.
#[tauri::command]
pub async fn diagnostics_text(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || report(&app)).await.map_err(|e| e.to_string())
}

fn stamp_for_name(secs: u64) -> String {
    utc(secs).replace('-', "").replace(':', "").replace(' ', "-")
}

/// Writes the report to the download folder (or Downloads/CloverEye) and
/// returns where.
#[tauri::command]
pub async fn diagnostics_save(app: tauri::AppHandle, dir: Option<String>) -> Result<String, String> {
    let folder = match dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) if Path::new(d).is_absolute() => PathBuf::from(d),
        _ => app.path().download_dir().map_err(|e| e.to_string())?.join("CloverEye"),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let text = report(&app);
        std::fs::create_dir_all(&folder).map_err(|e| format!("creating {}: {e}", folder.display()))?;
        let path = crate::extra::unique_path(&folder, &format!("clovereye-diagnostics-{}.txt", stamp_for_name(now_secs())));
        std::fs::write(&path, text).map_err(|e| format!("writing {}: {e}", path.display()))?;
        Ok(path.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// An error the UI caught (CloverEye's own windows only), for the report.
#[tauri::command]
pub fn diagnostics_note(webview: tauri::Webview, line: String) -> Result<(), String> {
    let label = webview.label();
    if label != "main" && !label.starts_with("w-") {
        return Err("not a CloverEye window".into());
    }
    let line: String = line.chars().take(400).collect();
    quiet(&format!("ui ({label}): {line}"), false);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_dates() {
        assert_eq!(utc(0), "1970-01-01 00:00:00");
        assert_eq!(utc(951_782_400), "2000-02-29 00:00:00");
        assert_eq!(utc(1_794_433_572), "2026-11-11 21:46:12");
        assert_eq!(stamp_for_name(1_794_433_572), "20261111-214612");
    }

    #[test]
    fn the_log_keeps_the_last_lines() {
        for i in 0..MAX_LINES + 5 {
            quiet(&format!("line {i}"), false);
        }
        let log = LOG.lock().unwrap();
        assert_eq!(log.lines.len(), MAX_LINES);
        assert!(log.lines.back().unwrap().ends_with(&format!("line {}", MAX_LINES + 4)));
        assert!(log.lines.iter().all(|l| !l.contains('\n')));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_report_names_webkit_and_crash_dumps() {
        let mut out = String::new();
        webkit_lines(&mut out);
        crash_dumps(&mut out);
        assert!(out.starts_with("WebKitGTK: 2."), "{out}");
        assert!(out.contains("DMA-BUF renderer: "), "{out}");
        assert!(out.contains("== WebKit web process crash dumps"), "{out}");
        assert!(!os_name().is_empty());
    }

    #[test]
    fn switches_never_carry_paths() {
        std::env::set_var("CLOVEREYE_TRY_CAPTCHA_FILE", "/home/someone/x.json");
        let sw = switches();
        std::env::remove_var("CLOVEREYE_TRY_CAPTCHA_FILE");
        assert!(sw.contains(&"CLOVEREYE_TRY_CAPTCHA_FILE=(set)".to_string()), "{sw:?}");
    }

    #[test]
    fn the_home_folder_reads_as_tilde() {
        if let Some(h) = home() {
            assert_eq!(tidy(&format!("saved to {h}/Downloads/x")), "saved to ~/Downloads/x");
        }
    }
}
