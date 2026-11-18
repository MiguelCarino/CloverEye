// Diagnostics: what to attach to a bug report, without a terminal.
//
// Every part of CloverEye logs here: the Rust commands (log_info! and the
// other macros below), the request queue (clovereye-fetch, through
// fetch_sink) and the UI (ui/js/log.js, in batches: diagnostics_log). A
// line is
//
//   2026-11-17 10:04:12.345 INFO  net: request queue summary requests=40 failed=0
//
// time (UTC), level (error, warn, info, debug), area, message and
// key=value fields. Debug lines are made only with Detailed logs on
// (Settings › Diagnostics, or CLOVEREYE_LOG_DETAIL=1 /
// CLOVEREYE_HELPER_DEBUG=1 in the environment); at the default level
// nothing is written per poll, so the file does not grow while the app sits
// idle.
//
// Lines are kept in memory (the last MAX_LINES, at most MAX_RING_BYTES) and
// in clovereye.log in the app's log folder; the log of the session before is
// kept as clovereye.old.log, for a crash. The file never grows past
// MAX_FILE_BYTES: past it, it is written again from the lines in memory.
// Settings › Diagnostics turns it into one text file: versions, the WebKit
// switches, recent web process crash dumps (Linux) and the logs.
//
// It holds no posts, names, subjects, captcha answers, cookies, tokens,
// prompts or answers: the code logs only numbers, sizes, ids and system
// messages, and every line also goes through scrub(): the home folder reads
// as ~, addresses are cut at the query, cookie and authorization headers and
// secret-looking key=value pairs are removed, and long random-looking
// tokens are replaced.

use std::collections::{BTreeMap, VecDeque};
use std::fmt::Display;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::Manager;

/// Lines kept in memory (and in the report).
const MAX_LINES: usize = 20_000;
/// ...and at most this many bytes of them.
const MAX_RING_BYTES: usize = 4 * 1024 * 1024;
/// The log file is written again from memory past this.
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// The longest line kept, in bytes.
const MAX_LINE_BYTES: usize = 1200;
const LOG_FILE: &str = "clovereye.log";
const OLD_LOG_FILE: &str = "clovereye.old.log";
/// How much of the session before goes in the report.
const OLD_LINES: usize = 500;

/// How much a line matters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Error,
    Warn,
    Info,
    Debug,
}

impl Level {
    pub const ALL: [Level; 4] = [Level::Error, Level::Warn, Level::Info, Level::Debug];

    pub fn name(self) -> &'static str {
        match self {
            Level::Error => "error",
            Level::Warn => "warn",
            Level::Info => "info",
            Level::Debug => "debug",
        }
    }

    /// The level column: upper case, padded to five.
    fn column(self) -> &'static str {
        match self {
            Level::Error => "ERROR",
            Level::Warn => "WARN ",
            Level::Info => "INFO ",
            Level::Debug => "DEBUG",
        }
    }

    pub fn parse(s: &str) -> Option<Level> {
        Level::ALL.into_iter().find(|l| l.name() == s)
    }

    fn index(self) -> usize {
        self as usize
    }
}

struct Log {
    lines: VecDeque<String>,
    ring_bytes: usize,
    file: Option<File>,
    written: u64,
    /// This session's lines by level and by area (also those that left
    /// the ring).
    levels: [u64; 4],
    areas: BTreeMap<String, u64>,
}

static LOG: Mutex<Log> = Mutex::new(Log {
    lines: VecDeque::new(),
    ring_bytes: 0,
    file: None,
    written: 0,
    levels: [0; 4],
    areas: BTreeMap::new(),
});
/// CloverEye turned WebKit's DMA-BUF renderer off itself (main.rs).
pub static DMABUF_GUARD_SET: AtomicBool = AtomicBool::new(false);
pub static HTTP1_GUARD_SET: AtomicBool = AtomicBool::new(false);

/// Detailed logs from the setting (Settings › Diagnostics).
static DETAIL_SETTING: AtomicBool = AtomicBool::new(false);
/// Detailed logs from the environment (CLOVEREYE_LOG_DETAIL=1).
static DETAIL_ENV: AtomicBool = AtomicBool::new(false);

/// Whether debug lines are kept.
pub fn detailed() -> bool {
    DETAIL_SETTING.load(Ordering::Relaxed) || DETAIL_ENV.load(Ordering::Relaxed)
}

/// Sets the setting's part of the detail switch; true when that changed.
pub fn set_detailed(on: bool) -> bool {
    let was = DETAIL_SETTING.swap(on, Ordering::Relaxed);
    clovereye_fetch::set_log_detail(detailed());
    was != on
}

fn env_on(k: &str) -> bool {
    std::env::var_os(k).is_some_and(|v| v != "0" && !v.is_empty())
}

/// Reads the environment's switch (CLOVEREYE_LOG_DETAIL=1, or the post
/// helper's CLOVEREYE_HELPER_DEBUG=1) and hands the request queue its sink.
pub fn init_early() {
    DETAIL_ENV.store(env_on("CLOVEREYE_LOG_DETAIL") || env_on("CLOVEREYE_HELPER_DEBUG"), Ordering::Relaxed);
    clovereye_fetch::set_log_sink(fetch_sink);
    clovereye_fetch::set_log_detail(detailed());
}

/// The request queue's lines (clovereye-fetch) into this log.
fn fetch_sink(level: clovereye_fetch::LogLevel, area: &str, msg: &str, fields: &[(&str, String)]) {
    use clovereye_fetch::LogLevel as L;
    let level = match level {
        L::Error => Level::Error,
        L::Warn => Level::Warn,
        L::Info => Level::Info,
        L::Debug => Level::Debug,
    };
    let f: Vec<(&str, &dyn Display)> = fields.iter().map(|(k, v)| (*k, v as &dyn Display)).collect();
    log_fields(level, area, msg, &f);
}

/// A line with fields: `log_info!("library", "loaded", items = n, ms = t)`.
/// Debug lines are not even formatted unless detailed logs are on.
macro_rules! log_at {
    ($lvl:expr, $area:expr, $msg:expr $(, $k:ident = $v:expr)* $(,)?) => {{
        let lvl: $crate::diag::Level = $lvl;
        if lvl != $crate::diag::Level::Debug || $crate::diag::detailed() {
            $crate::diag::log_fields(lvl, $area, &$msg, &[$((stringify!($k), &$v as &dyn ::std::fmt::Display)),*]);
        }
    }};
}
macro_rules! log_error {
    ($($t:tt)*) => { log_at!($crate::diag::Level::Error, $($t)*) };
}
macro_rules! log_warn {
    ($($t:tt)*) => { log_at!($crate::diag::Level::Warn, $($t)*) };
}
macro_rules! log_info {
    ($($t:tt)*) => { log_at!($crate::diag::Level::Info, $($t)*) };
}
macro_rules! log_debug {
    ($($t:tt)*) => { log_at!($crate::diag::Level::Debug, $($t)*) };
}

/// Milliseconds since `t`, for a `ms = ` field.
pub fn ms(t: Instant) -> u128 {
    t.elapsed().as_millis()
}

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

/// "2026-11-11 21:46:12.345" now.
fn stamp_now() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{}.{:03}", utc(d.as_secs()), d.subsec_millis())
}

/// An area is a short lower-case word ("net", "ai", "post"...).
pub fn valid_area(a: &str) -> bool {
    (1..=16).contains(&a.len()) && a.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// A field's value as written: bare when it is one plain word, else in
/// double quotes (inner quotes and backslashes escaped).
fn field_value(v: &str) -> String {
    let plain = !v.is_empty() && v.chars().all(|c| !c.is_whitespace() && c != '"' && c != '\\' && c != '=' && !c.is_control());
    if plain {
        return v.to_string();
    }
    let mut out = String::with_capacity(v.len() + 2);
    out.push('"');
    for c in v.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// One line as kept: time, level, area, message and fields, scrubbed, on
/// one line, at most MAX_LINE_BYTES.
fn format_line(time: &str, level: Level, area: &str, msg: &str, fields: &[(&str, String)]) -> String {
    let area = if valid_area(area) { area } else { "app" };
    let mut body = msg.replace(['\r', '\n', '\t'], " ");
    for (k, v) in fields {
        body.push(' ');
        body.push_str(k);
        body.push('=');
        body.push_str(&field_value(v));
    }
    let line = format!("{time} {} {area}: {}", level.column(), scrub(&body));
    cut(line, MAX_LINE_BYTES)
}

/// `s` cut to at most `max` bytes on a character boundary (with … when cut).
fn cut(mut s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut at = max.saturating_sub(3);
    while !s.is_char_boundary(at) {
        at -= 1;
    }
    s.truncate(at);
    s.push('…');
    s
}

/// Keeps a line; the terminal gets it when `print`.
fn keep(level: Level, area: &str, line: String, print: bool) {
    if print {
        eprintln!("clovereye {line}");
    }
    let mut log = LOG.lock().unwrap_or_else(|e| e.into_inner());
    log.levels[level.index()] += 1;
    *log.areas.entry(area.to_string()).or_insert(0) += 1;
    let bytes = line.len() + 1;
    if log.written + bytes as u64 > MAX_FILE_BYTES && log.file.is_some() {
        rewrite_file(&mut log);
    }
    let mut line = line;
    if let Some(f) = log.file.as_mut() {
        // one write per line (writeln! on a File makes two)
        line.push('\n');
        if f.write_all(line.as_bytes()).is_ok() {
            log.written += bytes as u64;
        }
        line.pop();
    }
    log.ring_bytes += bytes;
    log.lines.push_back(line);
    while log.lines.len() > MAX_LINES || log.ring_bytes > MAX_RING_BYTES {
        match log.lines.pop_front() {
            Some(old) => log.ring_bytes -= old.len() + 1,
            None => break,
        }
    }
}

/// The file reached its cap: it starts again with the lines in memory (the
/// newest), so it never grows past MAX_FILE_BYTES and keeps what matters.
fn rewrite_file(log: &mut Log) {
    let Some(mut f) = log.file.take() else { return };
    let ok = f.set_len(0).is_ok() && f.seek(SeekFrom::Start(0)).is_ok();
    if !ok {
        return; // the file is left closed: memory only from here
    }
    let head = format!("{} INFO  app: the log file reached {} MB; earlier lines were dropped", stamp_now(), MAX_FILE_BYTES / 1024 / 1024);
    // buffered: the ring is up to 4 MiB, written while LOG is held
    let written = write_lines(&mut f, std::iter::once(&head).chain(log.lines.iter()));
    log.file = Some(f);
    log.written = written;
}

/// Writes `lines` through one buffer (a syscall per 64 KiB, not per line);
/// the bytes written, or 0 when the write failed.
fn write_lines<'a>(f: &mut File, lines: impl Iterator<Item = &'a String>) -> u64 {
    let mut w = BufWriter::with_capacity(64 * 1024, f);
    let mut written = 0u64;
    for l in lines {
        if w.write_all(l.as_bytes()).and_then(|_| w.write_all(b"\n")).is_err() {
            break;
        }
        written += l.len() as u64 + 1;
    }
    if w.flush().is_err() {
        return 0;
    }
    written
}

/// A per-minute cap on lines from one source, optionally dropping a line
/// seen already this minute (the same page error from a loop).
pub struct MinuteGate {
    minute: u64,
    kept: u32,
    dropped: u32,
    seen: Vec<u64>,
}

impl MinuteGate {
    pub const fn new() -> Self {
        MinuteGate { minute: 0, kept: 0, dropped: 0, seen: Vec::new() }
    }

    /// Starts `minute` when it is a new one; the lines dropped in the one
    /// before, when any.
    fn turn(&mut self, minute: u64) -> Option<u32> {
        if self.minute == minute {
            return None;
        }
        let late = (self.dropped > 0).then_some(self.dropped);
        *self = MinuteGate { minute, kept: 0, dropped: 0, seen: Vec::new() };
        late
    }

    /// Room for `want` lines now, at most `cap` a minute: how many may be
    /// kept, and the lines dropped the minute before (to say so once).
    pub fn admit_n(&mut self, minute: u64, cap: u32, want: usize) -> (usize, Option<u32>) {
        let late = self.turn(minute);
        let room = (cap.saturating_sub(self.kept) as usize).min(want);
        self.kept += room as u32;
        self.dropped += (want - room) as u32;
        (room, late)
    }

    /// One line: kept unless past `cap`, or (with `dedupe`) the same text
    /// came already this minute.
    pub fn admit(&mut self, minute: u64, cap: u32, text: &str, dedupe: bool) -> (bool, Option<u32>) {
        let late = self.turn(minute);
        if dedupe {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            text.hash(&mut h);
            let h = h.finish();
            if self.seen.contains(&h) {
                self.dropped += 1;
                return (false, late);
            }
            if self.kept < cap {
                self.seen.push(h);
            }
        }
        if self.kept >= cap {
            self.dropped += 1;
            return (false, late);
        }
        self.kept += 1;
        (true, late)
    }
}

/// The minute now, for MinuteGate.
pub fn minute_now() -> u64 {
    now_secs() / 60
}

/// A line with fields. Debug lines are dropped unless detailed logs are on;
/// warnings and errors also go to the terminal.
pub fn log_fields(level: Level, area: &str, msg: &str, fields: &[(&str, &dyn Display)]) {
    if level == Level::Debug && !detailed() {
        return;
    }
    let owned: Vec<(&str, String)> = fields.iter().map(|(k, v)| (*k, v.to_string())).collect();
    let line = format_line(&stamp_now(), level, area, msg, &owned);
    let print = level <= Level::Warn || DETAIL_ENV.load(Ordering::Relaxed);
    keep(level, if valid_area(area) { area } else { "app" }, line, print);
}

/// A line without fields.
#[allow(dead_code)]
pub fn log(level: Level, area: &str, msg: &str) {
    log_fields(level, area, msg, &[]);
}

/// The area an older free-text line belongs to ("post helper: ..." is the
/// post helper's, "assistant: ..." the assistant's).
fn area_of(line: &str) -> (&'static str, &str) {
    for (prefix, area) in [("post helper: ", "post"), ("assistant: ", "ai")] {
        if let Some(rest) = line.strip_prefix(prefix) {
            return (area, rest);
        }
    }
    ("app", line)
}

/// An info line for the terminal and the report ("post helper: ...").
pub fn note(line: &str) {
    let (area, rest) = area_of(line);
    keep(Level::Info, area, format_line(&stamp_now(), Level::Info, area, rest, &[]), true);
}

/// An info line for the report only (the terminal sees it when `print`).
#[allow(dead_code)]
pub fn quiet(line: &str, print: bool) {
    let (area, rest) = area_of(line);
    keep(Level::Info, area, format_line(&stamp_now(), Level::Info, area, rest, &[]), print);
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

fn home() -> Option<&'static str> {
    static HOME: OnceLock<Option<String>> = OnceLock::new();
    HOME.get_or_init(|| std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok().filter(|h| h.len() > 1)).as_deref()
}

/// The home folder as ~, so the report does not carry the account name.
fn tidy(text: &str) -> String {
    match home() {
        Some(h) => text.replace(h, "~"),
        None => text.to_string(),
    }
}

/// Field names whose values are never kept (captcha, pass, session...).
const SECRET_KEYS: [&str; 24] = [
    "token", "t-response", "t-challenge", "t_response", "t_challenge", "challenge", "captcha", "response", "pwd", "password", "pass", "pass_id", "pass_token",
    "4chan_pass", "cookie", "cookies", "session", "sessionid", "auth", "authorization", "secret", "key", "apikey", "api_key",
];

/// Whether `t` looks like a random token (a captcha challenge, a session
/// id, a hash): long, of token characters only, switching between letters
/// and digits often. Model names, paths and words are not.
fn random_token(t: &str) -> bool {
    if t.len() < 32 || !t.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-+/=%".contains(&c)) {
        return false;
    }
    let mut switches = 0;
    let mut last: Option<bool> = None;
    for c in t.bytes().filter(u8::is_ascii_alphanumeric) {
        let digit = c.is_ascii_digit();
        if last.is_some_and(|l| l != digit) {
            switches += 1;
        }
        last = Some(digit);
    }
    switches >= 6
}

/// An error message without the paths and names it may carry ("writing
/// ~/Pictures/cat.jpg: No space left" → "writing (path): No space left"):
/// each of `known` (the folder, the file name) first, then any word that
/// looks like a path. For errors about files people named.
pub fn redact(e: &str, known: &[String]) -> String {
    let mut text = e.to_string();
    let mut known: Vec<&String> = known.iter().filter(|k| k.len() > 1).collect();
    known.sort_by_key(|k| std::cmp::Reverse(k.len()));
    for k in known {
        text = text.replace(k.as_str(), "(path)");
    }
    // A path runs to the ": " or " (os error" after it: a folder or file
    // name with spaces in it ("/mnt/My Folder/cat 1.jpg: ...") goes whole.
    let mut out: Vec<&str> = Vec::new();
    let mut in_path = false;
    for w in text.split(' ') {
        if in_path {
            if w.starts_with('(') {
                in_path = false; // "(os error 28)" is the system's
            } else {
                if w.ends_with(':') {
                    in_path = false;
                    if let Some(last) = out.last_mut() {
                        *last = "(path):";
                    }
                }
                continue;
            }
        }
        out.push(match w {
            "(path)" | "(path):" => w,
            _ if (w.contains('/') || w.contains('\\')) && !w.contains("://") => {
                if w.ends_with(':') {
                    "(path):"
                } else {
                    in_path = true;
                    "(path)"
                }
            }
            _ => w,
        });
    }
    out.join(" ").chars().take(300).collect()
}

/// One word of a line, scrubbed.
fn scrub_word(w: &str) -> String {
    // an address, or anything with a query string: cut at the query
    let lead = w.len() - w.trim_start_matches(['"', '(', '<', '\'']).len();
    let (pre, word) = w.split_at(lead);
    let is_url = word.contains("://");
    if let Some(q) = word.find(['?', '#']) {
        if is_url || word[q + 1..].contains('=') {
            let tail = if word.ends_with('"') { "\"" } else { "" };
            return format!("{pre}{}?…{tail}", &word[..q]);
        }
    }
    // key=value with a secret key
    if let Some((k, _)) = word.split_once(['=', ':']) {
        let key = k.trim_start_matches(['"', '-', '_']).to_ascii_lowercase();
        if SECRET_KEYS.contains(&key.as_str()) && word.len() > k.len() + 1 {
            return format!("{pre}{k}{}(removed)", &word[k.len()..k.len() + 1]);
        }
    }
    let core = word.trim_end_matches(['"', ')', '>', '\'', ',', ';', '.']);
    if random_token(core) {
        return format!("{pre}(token){}", &word[core.len()..]);
    }
    w.to_string()
}

/// The defensive pass over every line (see the top): home folder, query
/// strings, cookie and authorization headers, secret key=value pairs and
/// random-looking tokens.
pub fn scrub(line: &str) -> String {
    let mut text = tidy(line);
    // a header's value runs to the end of the line
    let lower = text.to_ascii_lowercase();
    if let Some(at) = ["set-cookie:", "cookie:", "authorization:", "bearer "].iter().filter_map(|h| lower.find(h).map(|i| i + h.len())).min() {
        text.truncate(at);
        text.push_str(" (removed)");
    }
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    for c in text.chars() {
        if c.is_whitespace() {
            if !word.is_empty() {
                out.push_str(&scrub_word(&word));
                word.clear();
            }
            out.push(c);
        } else {
            word.push(c);
        }
    }
    if !word.is_empty() {
        out.push_str(&scrub_word(&word));
    }
    out
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
    let (a, b, c) = soup_version();
    let http = match std::env::var("SOUP_FORCE_HTTP1") {
        Ok(_) if HTTP1_GUARD_SET.load(Ordering::SeqCst) => "HTTP/1.1 (CloverEye: this libsoup is older than 3.8; CLOVEREYE_HTTP2=1 keeps HTTP/2)".to_string(),
        Ok(v) => format!("HTTP/1.1 (SOUP_FORCE_HTTP1={v} set outside CloverEye)"),
        Err(_) => "HTTP/2 allowed".to_string(),
    };
    out.push_str(&format!("libsoup: {a}.{b}.{c}, {http}\n"));
}

/// The libsoup WebKit loaded (it is linked into this process).
#[cfg(target_os = "linux")]
pub fn soup_version() -> (u32, u32, u32) {
    unsafe { (soup3_sys::soup_get_major_version(), soup3_sys::soup_get_minor_version(), soup3_sys::soup_get_micro_version()) }
}

#[cfg(not(target_os = "linux"))]
fn webkit_lines(_out: &mut String) {}

/// Runs an already set-up command for at most `limit`: its output (stdout
/// and stderr apart), or None when it could not start or did not finish
/// in time. A late child is killed and reaped on a thread of its own, so
/// a process stuck in the kernel (a GPU that fell off the bus) never
/// holds the caller.
pub(crate) fn output_within(cmd: &mut std::process::Command, limit: Duration) -> Option<std::process::Output> {
    use std::io::Read;
    use std::process::Stdio;
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().ok()?;
    // Read both pipes as the child writes, so a full pipe never stalls it.
    let reader = |pipe: Option<Box<dyn Read + Send>>| {
        let (tx, rx) = std::sync::mpsc::channel();
        if let Some(mut pipe) = pipe {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = pipe.read_to_end(&mut buf);
                let _ = tx.send(buf);
            });
        }
        rx
    };
    let out = reader(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = reader(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let deadline = std::time::Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return None;
            }
        }
    };
    // The pipes close when the child exits (unless it left a process
    // holding them: then whatever came by the deadline).
    let left = deadline.saturating_duration_since(std::time::Instant::now()).max(Duration::from_millis(200));
    let stdout = out.recv_timeout(left).unwrap_or_default();
    let stderr = err.recv_timeout(Duration::from_millis(200)).unwrap_or_default();
    Some(std::process::Output { status, stdout, stderr })
}

/// Runs a read-only command for at most `limit`; its output, or None.
#[cfg(target_os = "linux")]
fn run_for(cmd: &str, args: &[&str], limit: Duration) -> Option<String> {
    let out = output_within(std::process::Command::new(cmd).args(args), limit)?;
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

/// The start-up line: versions, packaging, the session, the guards
/// CloverEye set for this WebKit and libsoup, and the detail switch.
pub fn startup(app: &tauri::AppHandle) {
    let mut f: Vec<(&str, String)> = vec![
        ("version", app.package_info().version.to_string()),
        ("os", os_name()),
        ("arch", std::env::consts::ARCH.to_string()),
        ("packaging", packaging().to_string()),
    ];
    if let Ok(s) = std::env::var("XDG_SESSION_TYPE") {
        f.push(("session", s));
    }
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::ffi;
        let (a, b, c) = unsafe { (ffi::webkit_get_major_version(), ffi::webkit_get_minor_version(), ffi::webkit_get_micro_version()) };
        f.push(("webkit", format!("{a}.{b}.{c}")));
        let (a, b, c) = soup_version();
        f.push(("libsoup", format!("{a}.{b}.{c}")));
        f.push(("dmabuf_guard", DMABUF_GUARD_SET.load(Ordering::SeqCst).to_string()));
        f.push(("http1_guard", HTTP1_GUARD_SET.load(Ordering::SeqCst).to_string()));
        let nv_off = std::env::var("GST_PLUGIN_FEATURE_RANK").is_ok_and(|v| v.contains("nvvp9dec:NONE")) && std::env::var_os("CLOVEREYE_HW_VIDEO").is_none();
        f.push(("nvidia_decoders_off", nv_off.to_string()));
    }
    f.push(("windows", app.webview_windows().len().to_string()));
    f.push(("detailed", detailed().to_string()));
    let refs: Vec<(&str, &dyn Display)> = f.iter().map(|(k, v)| (*k, v as &dyn Display)).collect();
    log_fields(Level::Info, "app", "started CloverEye", &refs);
}

/// The report's log summary: the detail switch, and this session's lines
/// by level and by area.
fn log_summary() -> String {
    let log = LOG.lock().unwrap_or_else(|e| e.into_inner());
    let detail = match (DETAIL_SETTING.load(Ordering::Relaxed), DETAIL_ENV.load(Ordering::Relaxed)) {
        (_, true) => "on (environment)",
        (true, false) => "on (Settings)",
        (false, false) => "off",
    };
    let levels = Level::ALL.iter().map(|l| format!("{}={}", l.name(), log.levels[l.index()])).collect::<Vec<_>>().join(" ");
    let areas = log.areas.iter().map(|(a, n)| format!("{a}={n}")).collect::<Vec<_>>().join(" ");
    format!("Log: detailed logs {detail}; this session's lines: {levels}; by area: {}\n", if areas.is_empty() { "none".into() } else { areas })
}

/// Run before a report is made: main.rs has the request queue write its
/// summary, so a short session's requests are in the report.
static BEFORE_REPORT: OnceLock<fn(&tauri::AppHandle)> = OnceLock::new();

pub fn before_report(f: fn(&tauri::AppHandle)) {
    let _ = BEFORE_REPORT.set(f);
}

pub fn report(app: &tauri::AppHandle) -> String {
    if let Some(f) = BEFORE_REPORT.get() {
        f(app);
    }
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
    out.push_str(&log_summary());
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
            out.push_str(&format!("\n== The session before (clovereye.old.log, last {OLD_LINES} lines)\n"));
            let lines: Vec<&str> = t.lines().collect();
            for l in &lines[lines.len().saturating_sub(OLD_LINES)..] {
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
        let t0 = Instant::now();
        let text = report(&app);
        std::fs::create_dir_all(&folder).map_err(|e| format!("creating {}: {e}", folder.display()))?;
        let path = crate::offline::write_new(&folder, &format!("clovereye-diagnostics-{}.txt", stamp_for_name(now_secs())), text.as_bytes())?;
        log_info!("app", "diagnostics file saved", bytes = text.len(), ms = ms(t0));
        Ok(path.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whether a window is one of CloverEye's own (main, w-*).
fn own_window(label: &str) -> bool {
    label == "main" || label.starts_with("w-")
}

/// Page errors kept a minute at most (the same one twice counts once).
const NOTES_PER_MIN: u32 = 30;
static NOTE_GATE: Mutex<MinuteGate> = Mutex::new(MinuteGate::new());

/// An error the UI caught (CloverEye's own windows only), for the report.
/// An error thrown on every frame would otherwise fill the log in minutes.
#[tauri::command(async)]
pub fn diagnostics_note(webview: tauri::Webview, line: String) -> Result<(), String> {
    let label = webview.label();
    if !own_window(label) {
        return Err("not a CloverEye window".into());
    }
    let line: String = line.chars().take(400).collect();
    let (keep, late) = NOTE_GATE.lock().unwrap_or_else(|e| e.into_inner()).admit(minute_now(), NOTES_PER_MIN, &line, true);
    if let Some(n) = late {
        log_warn!("ui", "page errors not kept (repeats, or past the per-minute cap)", n = n);
    }
    if keep {
        log_fields(Level::Error, "ui", &line, &[("win", &label)]);
    }
    Ok(())
}

// ------------------------------------------------------------ the UI's lines

/// Lines one batch from the UI may hold; the rest are dropped.
pub const MAX_BATCH: usize = 100;
/// The longest message from the UI, in characters.
const MAX_UI_MSG: usize = 200;
/// Fields one UI line may carry.
const MAX_UI_FIELDS: usize = 16;
/// The longest field value from the UI, in characters.
const MAX_UI_VALUE: usize = 160;
/// UI debug and info lines kept a minute at most (ui/js/log.js caps each
/// area lower).
const UI_PER_MIN: u32 = 1200;
/// UI warnings and errors kept a minute at most: a budget of their own, so
/// a busy minute of debug lines never drops them.
const UI_WARN_PER_MIN: u32 = 300;

/// Field names that carry what people write or look for: refused from the
/// UI whatever their value (ui/js/log.js refuses the same).
const CONTENT_KEYS: [&str; 40] = [
    "text", "com", "comment", "body", "content", "name", "names", "sub", "subject", "title", "prompt", "answer", "reply", "file", "filename", "filenames", "path",
    "dir", "folder", "terms", "term", "query", "q", "search", "pattern", "patterns", "tag", "tags", "email", "options", "trip", "tripcode", "captcha", "token",
    "cookie", "password", "pass", "pwd", "pasta", "message",
];

/// Whether a field name is one that carries content: one of CONTENT_KEYS,
/// or ending in one of the longer ones ("replyText", "fileName").
pub fn content_key(k: &str) -> bool {
    let k = k.to_ascii_lowercase();
    CONTENT_KEYS.iter().any(|c| k == *c || (c.len() >= 4 && k.ends_with(c)))
}

/// One UI line, checked: level, area, message and its fields as text.
#[derive(Debug, PartialEq)]
pub struct UiLine {
    pub level: Level,
    pub area: String,
    pub msg: String,
    pub fields: Vec<(String, String)>,
}

/// Reads a batch from the UI: at most MAX_BATCH lines, each with a known
/// level, a valid area and a message; fields are numbers, true/false or
/// short text, under plain names that are not content names. Debug lines
/// are dropped unless `detailed`. Returns the lines and how many were
/// refused.
pub fn ui_lines(batch: &[Value], detailed: bool) -> (Vec<UiLine>, usize) {
    let mut out = Vec::new();
    let mut refused = batch.len().saturating_sub(MAX_BATCH);
    for v in batch.iter().take(MAX_BATCH) {
        let level = v.get("level").and_then(Value::as_str).and_then(Level::parse);
        let area = v.get("area").and_then(Value::as_str).filter(|a| valid_area(a));
        let msg = v.get("msg").and_then(Value::as_str).map(str::trim).filter(|m| !m.is_empty());
        let (Some(level), Some(area), Some(msg)) = (level, area, msg) else {
            refused += 1;
            continue;
        };
        if level == Level::Debug && !detailed {
            continue;
        }
        let mut fields = Vec::new();
        if let Some(obj) = v.get("fields").and_then(Value::as_object) {
            for (k, val) in obj.iter() {
                if fields.len() >= MAX_UI_FIELDS {
                    break;
                }
                let key_ok = (1..=32).contains(&k.len()) && k.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') && !content_key(k) && k != "win";
                if !key_ok {
                    continue;
                }
                let text = match val {
                    Value::Bool(b) => b.to_string(),
                    Value::Number(n) => n.to_string(),
                    Value::String(s) => s.chars().filter(|c| !c.is_control()).take(MAX_UI_VALUE).collect(),
                    _ => continue,
                };
                fields.push((k.clone(), text));
            }
            fields.sort();
        }
        out.push(UiLine { level, area: area.to_string(), msg: msg.chars().filter(|c| !c.is_control()).take(MAX_UI_MSG).collect(), fields });
    }
    (out, refused)
}

/// The UI's debug and info lines this minute, and its warnings and errors.
static UI_RATE: Mutex<MinuteGate> = Mutex::new(MinuteGate::new());
static UI_WARN_RATE: Mutex<MinuteGate> = Mutex::new(MinuteGate::new());
static UI_REFUSED: AtomicU64 = AtomicU64::new(0);

/// The lines of a batch within the per-minute caps (debug and info share
/// one, warnings and errors have their own), in order; and the lines each
/// cap dropped the minute before.
fn ui_capped(lines: Vec<UiLine>, minute: u64, low: &Mutex<MinuteGate>, high: &Mutex<MinuteGate>) -> (Vec<UiLine>, Option<u32>, Option<u32>) {
    let warn = lines.iter().filter(|l| l.level <= Level::Warn).count();
    let (low_room, low_late) = low.lock().unwrap_or_else(|e| e.into_inner()).admit_n(minute, UI_PER_MIN, lines.len() - warn);
    let (high_room, high_late) = high.lock().unwrap_or_else(|e| e.into_inner()).admit_n(minute, UI_WARN_PER_MIN, warn);
    let (mut lo, mut hi) = (0, 0);
    let kept = lines
        .into_iter()
        .filter(|l| {
            if l.level <= Level::Warn {
                hi += 1;
                hi <= high_room
            } else {
                lo += 1;
                lo <= low_room
            }
        })
        .collect();
    (kept, low_late, high_late)
}

/// A batch of lines from ui/js/log.js (CloverEye's own windows only).
/// Returns whether detailed logs are on, so the page knows whether to make
/// debug lines.
/// Runs off the main thread: a batch can be the line that makes the file
/// start again (rewrite_file).
#[tauri::command(async)]
pub fn diagnostics_log(webview: tauri::Webview, lines: Vec<Value>) -> Result<bool, String> {
    let label = webview.label().to_string();
    if !own_window(&label) {
        return Err("not a CloverEye window".into());
    }
    let (lines, refused) = ui_lines(&lines, detailed());
    if refused > 0 && UI_REFUSED.fetch_add(refused as u64, Ordering::Relaxed) == 0 {
        log_warn!("ui", "refused lines from the page (bad shape or too many in one batch)", n = refused, win = label);
    }
    let (lines, low_late, high_late) = ui_capped(lines, minute_now(), &UI_RATE, &UI_WARN_RATE);
    if let Some(n) = low_late {
        log_warn!("ui", "dropped page lines past the per-minute cap", n = n, levels = "debug,info");
    }
    if let Some(n) = high_late {
        log_warn!("ui", "dropped page lines past the per-minute cap", n = n, levels = "warn,error");
    }
    for l in lines {
        let mut f: Vec<(&str, &dyn Display)> = l.fields.iter().map(|(k, v)| (k.as_str(), v as &dyn Display)).collect();
        if label != "main" {
            f.push(("win", &label));
        }
        log_fields(l.level, &l.area, &l.msg, &f);
    }
    Ok(detailed())
}

/// Turns detailed logs on or off (Settings › Diagnostics; settings.json's
/// diagnostics.detailed also sets it, main.rs). Returns the state now.
#[tauri::command]
pub fn set_log_detail(webview: tauri::Webview, on: bool) -> Result<bool, String> {
    if !own_window(webview.label()) {
        return Err("not a CloverEye window".into());
    }
    if set_detailed(on) {
        log_info!("settings", if on { "detailed logs on" } else { "detailed logs off" });
    }
    Ok(detailed())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Tests that write to the shared log or flip the detail switch take turns.
    static TURN: Mutex<()> = Mutex::new(());

    const T: &str = "2026-11-17 10:00:00.000";

    #[test]
    fn a_line_has_time_level_area_message_and_fields() {
        let l = format_line(T, Level::Info, "net", "catalog loaded", &[("board", "g".into()), ("ms", "231".into())]);
        assert_eq!(l, "2026-11-17 10:00:00.000 INFO  net: catalog loaded board=g ms=231");
        let l = format_line(T, Level::Debug, "ai", "answer", &[("stop", "length limit".into()), ("q", "a\"b".into())]);
        assert_eq!(l, "2026-11-17 10:00:00.000 DEBUG ai: answer stop=\"length limit\" q=\"a\\\"b\"");
        let l = format_line(T, Level::Warn, "Bad Area!", "two\nlines", &[]);
        assert_eq!(l, "2026-11-17 10:00:00.000 WARN  app: two lines");
        let long = format_line(T, Level::Error, "ui", &"é".repeat(2000), &[]);
        assert!(long.len() <= MAX_LINE_BYTES && long.ends_with('…'), "{}", long.len());
    }

    #[test]
    fn levels_read_and_order() {
        for l in Level::ALL {
            assert_eq!(Level::parse(l.name()), Some(l));
        }
        assert_eq!(Level::parse("trace"), None);
        assert!(Level::Error < Level::Warn && Level::Info < Level::Debug);
    }

    #[test]
    fn the_scrubber_cuts_queries_cookies_secrets_and_tokens() {
        assert_eq!(scrub("load https://sys.4chan.org/captcha?board=g&ticket=abc status=200"), "load https://sys.4chan.org/captcha?… status=200");
        assert_eq!(scrub("error=\"GET https://a.4cdn.org/x?y=1\""), "error=\"GET https://a.4cdn.org/x?…\"");
        assert_eq!(scrub("went to /g/post?mode=regist"), "went to /g/post?…");
        assert_eq!(scrub("Cookie: 4chan_pass=xyz; pass_id=abc"), "Cookie: (removed)");
        assert_eq!(scrub("sent Authorization: Bearer abc.def"), "sent Authorization: (removed)");
        assert_eq!(scrub("t-response=03AFcWeA5abc pwd=hunter2 status=ok"), "t-response=(removed) pwd=(removed) status=ok");
        assert_eq!(scrub("challenge 3f9a7c21b8e04d5a9c1f2e3d4b5a6978a1b2c3d4 sent"), "challenge (token) sent");
        // words, numbers, model names and the time are left alone
        for keep in ["model=llama3.1:8b", "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M", "lmstudio-community/meta-llama-3.1-8b-instruct", "thread=1793731659876000", "10:04:12.345", "kind=ollama port=11434"] {
            assert_eq!(scrub(keep), keep);
        }
        if let Some(h) = home() {
            assert_eq!(scrub(&format!("saved {h}/Downloads/x")), "saved ~/Downloads/x");
        }
    }

    #[test]
    fn ui_batches_are_checked_and_capped() {
        let batch = vec![
            json!({ "level": "info", "area": "tabs", "msg": "tab.opened", "fields": { "count": 3, "pinned": true, "kind": "thread" } }),
            json!({ "level": "debug", "area": "tabs", "msg": "tab.closed" }),
            json!({ "level": "loud", "area": "tabs", "msg": "x" }),
            json!({ "level": "info", "area": "Not An Area", "msg": "x" }),
            json!({ "level": "info", "area": "post", "msg": "  " }),
            json!({ "level": "warn", "area": "post", "msg": "post.failed", "fields": { "text": "my post", "replyText": "x", "fileName": "a.jpg", "threadTitle": "t", "terms": "a", "status": 403, "bad key": 1, "win": "w-9", "list": [1], "error": "e".repeat(500) } }),
        ];
        let (lines, refused) = ui_lines(&batch, false);
        assert_eq!(refused, 3);
        assert_eq!(lines.len(), 2, "the debug line is dropped with detail off");
        assert_eq!(lines[0], UiLine { level: Level::Info, area: "tabs".into(), msg: "tab.opened".into(), fields: vec![("count".into(), "3".into()), ("kind".into(), "thread".into()), ("pinned".into(), "true".into())] });
        let keys: Vec<&str> = lines[1].fields.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["error", "status"], "content keys, bad keys, win and lists are refused");
        assert_eq!(lines[1].fields[0].1.chars().count(), MAX_UI_VALUE);
        let (lines, _) = ui_lines(&batch, true);
        assert_eq!(lines.len(), 3, "with detail on the debug line stays");
        let many: Vec<Value> = (0..MAX_BATCH + 7).map(|_| json!({ "level": "info", "area": "ui", "msg": "m" })).collect();
        let (lines, refused) = ui_lines(&many, false);
        assert_eq!((lines.len(), refused), (MAX_BATCH, 7));
        let fields = json!({ "level": "info", "area": "ui", "msg": &"m".repeat(500), "fields": (0..40).map(|i| (format!("f{i}"), json!(i))).collect::<serde_json::Map<_, _>>() });
        let (lines, _) = ui_lines(&[fields], false);
        assert_eq!(lines[0].fields.len(), MAX_UI_FIELDS);
        assert_eq!(lines[0].msg.len(), MAX_UI_MSG);
    }

    #[test]
    fn content_keys_are_known_by_name_and_by_ending() {
        for k in ["text", "com", "name", "sub", "prompt", "answer", "title", "file", "filename", "terms", "query", "postText", "fileName", "tagTerms", "userPrompt"] {
            assert!(content_key(k), "{k}");
        }
        for k in ["count", "ms", "board", "thread", "status", "model", "chars", "bytes", "kind", "error"] {
            assert!(!content_key(k), "{k}");
        }
    }

    #[test]
    fn debug_lines_need_detailed_logs() {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        let count = || LOG.lock().unwrap().levels[Level::Debug.index()];
        set_detailed(false);
        let env = DETAIL_ENV.swap(false, Ordering::Relaxed);
        let before = count();
        log_debug!("test", "not kept", n = 1);
        assert_eq!(count(), before);
        set_detailed(true);
        log_debug!("test", "kept", n = 2);
        assert_eq!(count(), before + 1);
        assert!(LOG.lock().unwrap().lines.back().unwrap().ends_with("DEBUG test: kept n=2"));
        set_detailed(false);
        DETAIL_ENV.store(env, Ordering::Relaxed);
        assert!(log_summary().starts_with("Log: detailed logs "), "{}", log_summary());
        assert!(log_summary().contains("debug="));
    }

    #[test]
    fn errors_about_files_lose_their_paths_and_names() {
        let e = "writing /data/My Pictures/cat 1.jpg: No space left on device (os error 28)";
        assert_eq!(redact(e, &["/data/My Pictures".into(), "cat 1.jpg".into()]), "writing (path)/(path): No space left on device (os error 28)".replace("(path)/(path)", "(path)"));
        assert_eq!(redact("creating /x/y: denied", &[]), "creating (path): denied");
        assert_eq!(redact("The file is gone from the site.", &["n.jpg".into()]), "The file is gone from the site.");
        // folder and file names with spaces, not passed as known
        assert_eq!(redact("creating /mnt/Stuff/My Secret Folder/cat girl 1.jpg: No space left", &[]), "creating (path): No space left");
        assert_eq!(
            redact("writing /mnt/Stuff/My Secret Folder/g-1-slug/thread.json.tmp: No space left on device (os error 28)", &[]),
            "writing (path): No space left on device (os error 28)"
        );
        assert_eq!(redact("deleting /a/My Secret Folder (os error 13)", &[]), "deleting (path) (os error 13)");
        let r = redact("/mnt/Stuff/My Secret Folder is not a folder.", &[]);
        assert!(!r.contains("Secret"), "{r}");
        assert_eq!(redact("/mnt/My Folder is not a folder.", &["/mnt/My Folder".into()]), "(path) is not a folder.");
    }

    #[test]
    fn older_lines_find_their_area() {
        assert_eq!(area_of("post helper: request 3: captcha"), ("post", "request 3: captcha"));
        assert_eq!(area_of("assistant: found nothing"), ("ai", "found nothing"));
        assert_eq!(area_of("started"), ("app", "started"));
    }

    #[cfg(unix)]
    #[test]
    fn a_command_that_does_not_finish_in_time_is_killed_and_does_not_hold_the_caller() {
        let t0 = std::time::Instant::now();
        let mut cmd = std::process::Command::new("sleep");
        cmd.arg("30");
        assert!(output_within(&mut cmd, Duration::from_millis(200)).is_none());
        assert!(t0.elapsed() < Duration::from_secs(5), "waited {:?}", t0.elapsed());
    }

    #[cfg(unix)]
    #[test]
    fn a_quick_command_gives_its_output_with_stdout_and_stderr_apart() {
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "echo out; echo err >&2; exit 3"]);
        let o = output_within(&mut cmd, Duration::from_secs(10)).unwrap();
        assert_eq!(o.stdout, b"out\n");
        assert_eq!(o.stderr, b"err\n");
        assert_eq!(o.status.code(), Some(3));
    }

    #[cfg(unix)]
    #[test]
    fn a_command_that_writes_more_than_a_pipe_holds_still_finishes() {
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "head -c 300000 /dev/zero"]);
        let o = output_within(&mut cmd, Duration::from_secs(10)).unwrap();
        assert_eq!(o.stdout.len(), 300_000);
    }

    #[test]
    fn a_missing_command_is_none() {
        let mut cmd = std::process::Command::new("clovereye-no-such-command");
        assert!(output_within(&mut cmd, Duration::from_secs(1)).is_none());
    }

    #[test]
    fn utc_dates() {
        assert_eq!(utc(0), "1970-01-01 00:00:00");
        assert_eq!(utc(951_782_400), "2000-02-29 00:00:00");
        assert_eq!(utc(1_794_433_572), "2026-11-11 21:46:12");
        assert_eq!(stamp_for_name(1_794_433_572), "20261111-214612");
    }

    #[test]
    fn the_log_keeps_the_last_lines() {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
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
    fn a_gate_caps_a_minute_and_drops_repeats() {
        let mut g = MinuteGate::new();
        assert_eq!(g.admit(5, 3, "a", true), (true, None));
        assert_eq!(g.admit(5, 3, "a", true), (false, None)); // a repeat
        assert_eq!(g.admit(5, 3, "b", true), (true, None));
        assert_eq!(g.admit(5, 3, "c", true), (true, None));
        assert_eq!(g.admit(5, 3, "d", true), (false, None)); // past the cap
        assert_eq!(g.admit(6, 3, "a", true), (true, Some(2))); // a new minute says so once
        assert_eq!(g.admit_n(6, 3, 5), (2, None));
        assert_eq!(g.admit_n(7, 3, 1), (1, Some(3)));
    }

    #[test]
    fn warnings_from_the_page_survive_a_busy_minute_of_debug_lines() {
        let line = |level, msg: &str| UiLine { level, area: "thread".into(), msg: msg.into(), fields: vec![] };
        let (low, high) = (Mutex::new(MinuteGate::new()), Mutex::new(MinuteGate::new()));
        let busy: Vec<UiLine> = (0..UI_PER_MIN).map(|_| line(Level::Debug, "poll")).collect();
        assert_eq!(ui_capped(busy, 9, &low, &high).0.len(), UI_PER_MIN as usize);
        let batch = vec![line(Level::Debug, "poll"), line(Level::Error, "thread.failed"), line(Level::Info, "x"), line(Level::Warn, "slow")];
        let (kept, ..) = ui_capped(batch, 9, &low, &high);
        let msgs: Vec<&str> = kept.iter().map(|l| l.msg.as_str()).collect();
        assert_eq!(msgs, ["thread.failed", "slow"]);
        let (_, low_late, high_late) = ui_capped(vec![], 10, &low, &high);
        assert_eq!((low_late, high_late), (Some(2), None));
    }

    #[test]
    fn a_rewrite_writes_every_line_through_one_buffer() {
        let path = std::env::temp_dir().join(format!("ce-diag-rewrite-{}", std::process::id()));
        let mut f = File::create(&path).unwrap();
        let lines: Vec<String> = (0..2000).map(|i| format!("line {i}")).collect();
        let n = write_lines(&mut f, lines.iter());
        drop(f);
        let text = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(n as usize, text.len());
        assert_eq!(text.lines().count(), 2000);
        assert!(text.ends_with("line 1999\n"));
    }

    #[test]
    fn the_home_folder_reads_as_tilde() {
        if let Some(h) = home() {
            assert_eq!(tidy(&format!("saved to {h}/Downloads/x")), "saved to ~/Downloads/x");
        }
    }
}
