// Threads saved for reading offline, and "Download all files".
//
// Layout, inside one folder (Settings → Files → Saved threads; by default
// <Downloads>/CloverEye/Saved threads):
//
//   index.json                         the saved threads: board, No., title, date
//   <board>-<no>-<slug>/thread.json    the thread as the API sent it
//   <board>-<no>-<slug>/files/<tim><ext>
//   <board>-<no>-<slug>/thumbs/<tim>s.jpg
//
// The thread's JSON comes from the UI, which loaded it through the one
// request queue; nothing here asks the API for anything. Files come from the
// image host, one at a time, at least 1 s apart (SCOPE §3.1: download all,
// throttled), and only when the person asked. Every path is built here from
// checked parts (board ^[a-z0-9]{1,10}$, numbers, an extension from a short
// list), never from a path the UI sends, and only inside the chosen folder.
//
// Saved files are shown back through the app's own `cesaved:` scheme, which
// serves only <folder>/<board>-<no>-*/files/<tim><ext> and thumbs/<tim>s.jpg
// to CloverEye's own windows. Chosen over Tauri's asset protocol: that one
// serves any file under its scope, and the scope would be a folder the person
// picks (it could be their home folder); this one cannot name anything else.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, UriSchemeContext, UriSchemeResponder};

pub const SCHEME: &str = "cesaved";
const INDEX: &str = "index.json";
const THREAD: &str = "thread.json";
const EXTS: [&str; 6] = [".jpg", ".png", ".gif", ".webm", ".mp4", ".pdf"];
const MAX_FILE: u64 = 64 * 1024 * 1024;
const MAX_THREAD_JSON: usize = 32 * 1024 * 1024;
/// index.json is read only up to this; a larger one is left as it is.
const MAX_INDEX: usize = 32 * 1024 * 1024;
/// Downloads go out one at a time, at least this far apart.
const GAP: Duration = Duration::from_secs(1);
/// What one range request of a saved video gets at most.
const RANGE_CHUNK: u64 = 2 * 1024 * 1024;

#[derive(Default)]
pub struct OfflineState {
    /// The folder last used, for the `cesaved:` scheme.
    root: Mutex<Option<PathBuf>>,
    /// index.json is read, changed and written under this.
    index: Mutex<()>,
    /// When the last download ended; held for the whole of each download.
    gate: tokio::sync::Mutex<Option<Instant>>,
}

// ------------------------------------------------------------ checked parts

pub fn valid_board(b: &str) -> bool {
    (1..=10).contains(&b.len()) && b.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

pub fn valid_ext(ext: &str) -> bool {
    EXTS.contains(&ext)
}

fn valid_num(n: u64) -> bool {
    n > 0
}

/// A short, safe slug of the title for the folder name: a-z, 0-9 and dashes.
pub fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 40 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

/// The folder name a new saved thread gets.
pub fn thread_dir_name(board: &str, no: u64, title: &str) -> String {
    let s = slug(title);
    if s.is_empty() {
        format!("{board}-{no}")
    } else {
        format!("{board}-{no}-{s}")
    }
}

/// Whether a folder name is a saved thread's, and whose: (board, no).
pub fn parse_dir_name(name: &str) -> Option<(String, u64)> {
    let mut parts = name.splitn(3, '-');
    let board = parts.next()?;
    let no: u64 = parts.next()?.parse().ok()?;
    let rest = parts.next().unwrap_or("");
    let rest_ok = rest.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-');
    (valid_board(board) && valid_num(no) && rest_ok && no.to_string().len() <= 20).then(|| (board.to_string(), no))
}

/// Where one file goes inside a thread's folder: files/<tim><ext> or
/// thumbs/<tim>s.jpg.
pub fn file_rel(kind: &str, tim: u64, ext: &str) -> Result<PathBuf, String> {
    if !valid_num(tim) {
        return Err("Not a file number.".into());
    }
    match kind {
        "full" if valid_ext(ext) => Ok(Path::new("files").join(format!("{tim}{ext}"))),
        "full" => Err("That kind of file is not saved.".into()),
        "thumb" => Ok(Path::new("thumbs").join(format!("{tim}s.jpg"))),
        _ => Err("Not a kind of file.".into()),
    }
}

/// The image host's address of one file or thumbnail.
pub fn file_url(board: &str, kind: &str, tim: u64, ext: &str) -> Result<String, String> {
    if !valid_board(board) {
        return Err(format!("not a board code: {board:?}"));
    }
    file_rel(kind, tim, ext)?;
    Ok(match kind {
        "thumb" => format!("https://i.4cdn.org/{board}/{tim}s.jpg"),
        _ => format!("https://i.4cdn.org/{board}/{tim}{ext}"),
    })
}

/// A request path of the `cesaved:` scheme, `/<board>/<no>/files/<tim><ext>`
/// or `/<board>/<no>/thumbs/<tim>s.jpg` (each part may be percent-encoded):
/// (board, no, path inside the thread's folder, content type).
pub fn parse_scheme_path(raw: &str) -> Option<(String, u64, PathBuf, &'static str)> {
    let path = pct_decode(raw)?;
    let mut parts = path.trim_start_matches('/').split('/');
    let (Some(board), Some(no), Some(kind), Some(file), None) = (parts.next(), parts.next(), parts.next(), parts.next(), parts.next()) else {
        return None;
    };
    let no: u64 = no.parse().ok().filter(|n| valid_num(*n))?;
    if !valid_board(board) {
        return None;
    }
    let (stem, ext) = match kind {
        "files" => {
            let dot = file.find('.')?;
            (&file[..dot], &file[dot..])
        }
        "thumbs" => (file.strip_suffix("s.jpg")?, ".jpg"),
        _ => return None,
    };
    if stem.is_empty() || stem.len() > 20 || !stem.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let tim: u64 = stem.parse().ok()?;
    let rel = file_rel(if kind == "files" { "full" } else { "thumb" }, tim, ext).ok()?;
    Some((board.to_string(), no, rel, content_type(ext)))
}

fn content_type(ext: &str) -> &'static str {
    match ext {
        ".jpg" => "image/jpeg",
        ".png" => "image/png",
        ".gif" => "image/gif",
        ".webm" => "video/webm",
        ".mp4" => "video/mp4",
        ".pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn pct_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A single `bytes=a-b` range of a file `len` long, as (start, end) inclusive,
/// at most RANGE_CHUNK long. None: no usable range (the whole file is sent).
pub fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let spec = value.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || len == 0 {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (len.saturating_sub(n), len - 1)
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() { len - 1 } else { b.parse::<u64>().ok()?.min(len - 1) };
        (start, end)
    };
    if start > end || start >= len {
        return None;
    }
    Some((start, end.min(start + RANGE_CHUNK - 1)))
}

// ---------------------------------------------------------------- folders

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn default_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().download_dir().map_err(|e| e.to_string())?.join("CloverEye").join("Saved threads"))
}

/// The saved-threads folder: Settings' (absolute paths only) or the default.
/// Remembered for the `cesaved:` scheme.
fn root_of(app: &tauri::AppHandle, dir: Option<&str>) -> Result<PathBuf, String> {
    let root = match dir.map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) if Path::new(d).is_absolute() && !d.contains('\0') => PathBuf::from(d),
        Some(_) => return Err("The saved threads folder must be a full path.".into()),
        None => default_root(app)?,
    };
    *app.state::<OfflineState>().root.lock().unwrap() = Some(root.clone());
    Ok(root)
}

/// A folder the person chose (or its default): made if it is missing. It
/// may be a link (a Downloads folder often is).
fn ensure_dir(p: &Path) -> Result<(), String> {
    match std::fs::metadata(p) {
        Ok(m) if m.is_dir() => Ok(()),
        Ok(_) => Err(format!("{} is not a folder.", p.display())),
        Err(_) => std::fs::create_dir_all(p).map_err(|e| format!("creating {}: {e}", p.display())),
    }
}

/// A folder inside a saved thread: real (never a link out), made if missing.
fn real_dir(p: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => Ok(()),
        Ok(_) => Err(format!("{} is not a folder.", p.display())),
        Err(_) => std::fs::create_dir_all(p).map_err(|e| format!("creating {}: {e}", p.display())),
    }
}

/// The saved thread's folder inside `root`, if it was saved: a real folder
/// named <board>-<no> or <board>-<no>-<slug>.
pub fn find_thread_dir(root: &Path, board: &str, no: u64) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        if parse_dir_name(name).is_some_and(|(b, n)| b == board && n == no) {
            let p = e.path();
            if std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_dir()) {
                return Some(p);
            }
        }
    }
    None
}

/// A file's bytes, read through a cap so a huge file is never read whole:
/// Ok(None) when it is larger than `max`. Errors (NotFound...) as they are.
pub(crate) fn read_capped(path: &Path, max: usize) -> std::io::Result<Option<Vec<u8>>> {
    let file = std::fs::File::open(path)?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut bytes = Vec::with_capacity(len.min(max as u64 + 1) as usize);
    file.take(max as u64 + 1).read_to_end(&mut bytes)?;
    Ok((bytes.len() <= max).then_some(bytes))
}

/// Saving a thread refuses to replace an index.json it could not read (it
/// would come back with one thread in it); a delete leaves such a file be.
const INDEX_UNREADABLE: &str = "index.json in the saved threads folder can’t be read, so it was not replaced.";

/// index.json's threads: Ok(None) when there is none yet; an error when it
/// cannot be read, is larger than MAX_INDEX or is not an index (no
/// "threads" list). Such a file is never taken for an empty index.
fn read_index(root: &Path) -> Result<Option<Vec<Value>>, String> {
    let bytes = match read_capped(&root.join(INDEX), MAX_INDEX) {
        Ok(Some(b)) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Ok(None) => {
            log_warn!("offline", "saved threads' index.json is too large to read; left as it is", max = MAX_INDEX);
            return Err(INDEX_UNREADABLE.to_string());
        }
        Err(e) => {
            log_warn!("offline", "saved threads' index.json can't be read; left as it is", error = e.kind());
            return Err(INDEX_UNREADABLE.to_string());
        }
    };
    let threads = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v.get("threads").and_then(Value::as_array).cloned());
    if threads.is_none() {
        log_warn!("offline", "saved threads' index.json is not an index; left as it is", bytes = bytes.len());
    }
    threads.map(Some).ok_or_else(|| INDEX_UNREADABLE.to_string())
}

/// index.json's threads, only to show them: none when it is missing or
/// cannot be read (the folders still list).
fn index_entries(root: &Path) -> Vec<Value> {
    read_index(root).ok().flatten().unwrap_or_default()
}

/// The ending of the temporary files a write goes through.
const TMP_SUFFIX: &str = ".clovereye-part";

/// A temporary name next to `path` that no one else's file has: hidden,
/// with the process, a counter and the time in it, and CloverEye's own
/// ending (which dir_files skips).
fn temp_path(path: &Path) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!(".{name}.{}-{n}-{nanos}{TMP_SUFFIX}", std::process::id()))
}

/// Writes `bytes` to `path` through a temporary file that is created new
/// (an existing file or link of that name is never opened), then renamed
/// into place.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = temp_path(path);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .and_then(|mut f| f.write_all(bytes).and_then(|_| f.sync_all()))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("writing {}: {e}", tmp.display())
        })?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("saving {}: {e}", path.display())
    })
}

/// Writes `bytes` as a new file in `dir` named `name`, or `name-2`... when
/// that is taken, and returns its path. Never replaces a file: the name is
/// first claimed by creating it empty (create_new, so a file or link that
/// appears in the meantime makes it try the next name), then the bytes go
/// through a temporary file renamed onto that claim. For files that must
/// replace (indexes, thread.json), use write_atomic.
pub(crate) fn write_new(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    // name..name-9999, then a hundred with the time in them
    for candidate in crate::extra::name_candidates(name).take(10_099) {
        let path = dir.join(&candidate);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(claim) => drop(claim),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e).map_err(|e| format!("writing {}: {e}", path.display())),
        }
        return match write_atomic(&path, bytes) {
            Ok(()) => Ok(path),
            Err(e) => {
                let _ = std::fs::remove_file(&path);
                Err(e)
            }
        };
    }
    Err(format!("There are too many files named {name} in {}.", dir.display()))
}

fn write_index(root: &Path, threads: &[Value]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&json!({ "version": 1, "threads": threads })).map_err(|e| e.to_string())?;
    write_atomic(&root.join(INDEX), &bytes)
}

fn same_thread(v: &Value, board: &str, no: u64) -> bool {
    v.get("board").and_then(Value::as_str) == Some(board) && v.get("no").and_then(Value::as_u64) == Some(no)
}

/// Names of the files in one of a thread's folders, and their total size.
fn dir_files(dir: &Path) -> (Vec<String>, u64) {
    let mut names = Vec::new();
    let mut bytes = 0;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let Ok(m) = e.metadata() else { continue };
            if !m.is_file() {
                continue;
            }
            if let Some(n) = e.file_name().to_str() {
                if n.ends_with(TMP_SUFFIX) {
                    continue;
                }
                names.push(n.to_string());
                bytes += m.len();
            }
        }
    }
    names.sort();
    (names, bytes)
}

fn check_thread(board: &str, no: u64) -> Result<(), String> {
    if !valid_board(board) {
        return Err(format!("not a board code: {board:?}"));
    }
    if !valid_num(no) {
        return Err("not a thread number".into());
    }
    Ok(())
}

// --------------------------------------------------------------- commands

/// The saved threads, newest first: { board, no, title, folder, savedAt,
/// posts, files, bytes }. Folders without an index entry still count.
#[tauri::command]
pub async fn offline_list(app: tauri::AppHandle, dir: Option<String>) -> Result<Value, String> {
    let root = root_of(&app, dir.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let index = index_entries(&root);
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(&root) else { return Ok(json!([])) };
        for e in entries.flatten() {
            let name = e.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some((board, no)) = parse_dir_name(name) else { continue };
            let p = e.path();
            if !std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_dir()) || !p.join(THREAD).is_file() {
                continue;
            }
            let meta = index.iter().find(|v| same_thread(v, &board, no));
            let (files, fbytes) = dir_files(&p.join("files"));
            let (_, tbytes) = dir_files(&p.join("thumbs"));
            let jbytes = std::fs::metadata(p.join(THREAD)).map(|m| m.len()).unwrap_or(0);
            let saved_at = meta.and_then(|m| m.get("savedAt")).and_then(Value::as_u64).unwrap_or_else(|| {
                std::fs::metadata(p.join(THREAD))
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            });
            out.push(json!({
                "board": board,
                "no": no,
                "title": meta.and_then(|m| m.get("title")).and_then(Value::as_str).unwrap_or(""),
                "folder": p.display().to_string(),
                "savedAt": saved_at,
                "posts": meta.and_then(|m| m.get("posts")).and_then(Value::as_u64).unwrap_or(0),
                "files": files.len(),
                "bytes": fbytes + tbytes + jbytes,
            }));
        }
        out.sort_by_key(|v| std::cmp::Reverse(v.get("savedAt").and_then(Value::as_u64).unwrap_or(0)));
        let total: u64 = out.iter().filter_map(|v| v.get("bytes").and_then(Value::as_u64)).sum();
        log_debug!("offline", "saved threads listed", threads = out.len(), indexed = index.len(), bytes = total, ms = crate::diag::ms(t0));
        Ok(Value::Array(out))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One saved thread from disk: { thread, folder, title, savedAt, files,
/// thumbs } (the file names there). Error "not-saved" when it is not.
#[tauri::command]
pub async fn offline_read(app: tauri::AppHandle, dir: Option<String>, board: String, no: u64) -> Result<Value, String> {
    check_thread(&board, no)?;
    let root = root_of(&app, dir.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let folder = find_thread_dir(&root, &board, no).ok_or("not-saved")?;
        let Some(bytes) = read_capped(&folder.join(THREAD), MAX_THREAD_JSON).map_err(|_| "not-saved".to_string())? else {
            log_warn!("offline", "saved thread too large to read", board = board, thread = no, max = MAX_THREAD_JSON);
            return Err("The saved thread is larger than CloverEye reads (32 MB).".to_string());
        };
        let thread: Value = serde_json::from_slice(&bytes).map_err(|e| {
            log_warn!("offline", "saved thread is damaged", board = board, thread = no, bytes = bytes.len(), error = e);
            format!("The saved thread is damaged: {e}")
        })?;
        log_debug!("offline", "saved thread read", board = board, thread = no, bytes = bytes.len(), posts = thread.get("posts").and_then(Value::as_array).map_or(0, Vec::len), ms = crate::diag::ms(t0));
        let meta = index_entries(&root).into_iter().find(|v| same_thread(v, &board, no));
        Ok(json!({
            "thread": thread,
            "folder": folder.display().to_string(),
            "title": meta.as_ref().and_then(|m| m.get("title")).and_then(Value::as_str).unwrap_or(""),
            "savedAt": meta.as_ref().and_then(|m| m.get("savedAt")).and_then(Value::as_u64).unwrap_or(0),
            "files": dir_files(&folder.join("files")).0,
            "thumbs": dir_files(&folder.join("thumbs")).0,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Writes (or replaces) a thread's thread.json and its index entry, making
/// its folders. The JSON is what the UI loaded through the request queue.
#[tauri::command]
pub async fn offline_write_thread(app: tauri::AppHandle, dir: Option<String>, board: String, no: u64, title: String, thread: Value) -> Result<String, String> {
    check_thread(&board, no)?;
    let posts = thread.get("posts").and_then(Value::as_array).ok_or("The thread has no posts.")?;
    if posts.first().and_then(|p| p.get("no")).and_then(Value::as_u64) != Some(no) {
        return Err("The posts are not this thread's.".into());
    }
    let count = posts.len();
    let bytes = serde_json::to_vec(&thread).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_THREAD_JSON {
        return Err("The thread is larger than CloverEye saves.".into());
    }
    let title: String = title.chars().filter(|c| !c.is_control()).take(200).collect();
    let root = root_of(&app, dir.as_deref())?;
    // the folder is the person's choice: never in the log
    let hide = [root.display().to_string()];
    let handle = app.clone();
    let (b, size, t0) = (board.clone(), bytes.len(), Instant::now());
    let out = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<OfflineState>();
        let _lock = state.index.lock().unwrap();
        ensure_dir(&root)?;
        // an index.json that cannot be read is kept, and nothing is written
        let index = read_index(&root)?.unwrap_or_default();
        let folder = match find_thread_dir(&root, &board, no) {
            Some(f) => f,
            None => root.join(thread_dir_name(&board, no, &title)),
        };
        real_dir(&folder)?;
        real_dir(&folder.join("files"))?;
        real_dir(&folder.join("thumbs"))?;
        write_atomic(&folder.join(THREAD), &bytes)?;
        let mut index: Vec<Value> = index.into_iter().filter(|v| !same_thread(v, &board, no)).collect();
        index.push(json!({
            "board": board,
            "no": no,
            "title": title,
            "folder": folder.file_name().and_then(|n| n.to_str()).unwrap_or_default(),
            "savedAt": now_ms(),
            "posts": count,
        }));
        write_index(&root, &index)?;
        Ok(folder.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    match &out {
        Ok(_) => log_info!("offline", "thread saved", board = b, thread = no, posts = count, bytes = size, ms = t0.elapsed().as_millis()),
        Err(e) => log_warn!("offline", "thread not saved", board = b, thread = no, error = crate::diag::redact(e, &hide)),
    }
    out
}

/// Waits for the download gate: one download at a time, each starting at
/// least GAP after the last one ended.
pub(crate) async fn gated<T>(app: &tauri::AppHandle, job: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String>
where
    T: Send + 'static,
{
    let state = app.state::<OfflineState>();
    let t0 = Instant::now();
    let mut last = state.gate.lock().await;
    if let Some(t) = *last {
        let since = t.elapsed();
        if since < GAP {
            tokio::time::sleep(GAP - since).await;
        }
    }
    log_debug!("files", "download gate passed", waited_ms = t0.elapsed().as_millis());
    let out = tauri::async_runtime::spawn_blocking(job).await.map_err(|e| e.to_string());
    *last = Some(Instant::now());
    out?
}

pub(crate) fn download(url: &str) -> Result<Vec<u8>, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .user_agent(&clovereye_fetch::user_agent())
        .redirects(0)
        .build();
    let t0 = Instant::now();
    let res = agent.get(url).call().map_err(|e| {
        let status = match &e {
            ureq::Error::Status(code, _) => code.to_string(),
            ureq::Error::Transport(t) => format!("{}", t.kind()),
        };
        log_debug!("files", "image host request failed", status = status, ms = t0.elapsed().as_millis());
        match e {
            ureq::Error::Status(404, _) => "not-found".to_string(),
            other => other.to_string(),
        }
    })?;
    let mut body = Vec::new();
    res.into_reader().take(MAX_FILE + 1).read_to_end(&mut body).map_err(|e| e.to_string())?;
    if body.len() as u64 > MAX_FILE {
        log_warn!("files", "file from the image host is larger than CloverEye saves", max = MAX_FILE);
        return Err("The file is larger than CloverEye saves.".into());
    }
    log_debug!("files", "image host request", status = 200, bytes = body.len(), ms = t0.elapsed().as_millis());
    Ok(body)
}

/// Saves one file (kind "full") or thumbnail ("thumb") of a saved thread
/// from the image host: { status: "saved" | "skipped", bytes }. Skipped,
/// with no request, when it is already there (the full file at its `size`).
#[tauri::command]
pub async fn offline_fetch_file(
    app: tauri::AppHandle,
    dir: Option<String>,
    board: String,
    no: u64,
    tim: u64,
    ext: String,
    kind: String,
    size: Option<u64>,
) -> Result<Value, String> {
    check_thread(&board, no)?;
    let url = file_url(&board, &kind, tim, &ext)?;
    let rel = file_rel(&kind, tim, &ext)?;
    let root = root_of(&app, dir.as_deref())?;
    let folder = find_thread_dir(&root, &board, no).ok_or("Save the thread first.")?;
    let sub = folder.join(rel.parent().unwrap_or(Path::new("")));
    real_dir(&sub)?;
    let path = folder.join(&rel);
    if let Ok(m) = std::fs::symlink_metadata(&path) {
        let done = m.is_file() && m.len() > 0 && (kind == "thumb" || size.map_or(true, |s| s == 0 || s == m.len()));
        if done {
            log_debug!("offline", "file already saved; skipped", board = board, thread = no, kind = kind);
            return Ok(json!({ "status": "skipped", "bytes": m.len() }));
        }
        if !m.is_file() {
            return Err(format!("{} is not a file.", path.display()));
        }
    }
    let (b, k, t0) = (board.clone(), kind.clone(), Instant::now());
    let hide = [root.display().to_string()];
    let out = gated(&app, move || {
        let body = download(&url)?;
        write_atomic(&path, &body)?;
        Ok(json!({ "status": "saved", "bytes": body.len() }))
    })
    .await;
    match &out {
        Ok(v) => log_debug!("offline", "file saved for offline", board = b, thread = no, kind = k, bytes = v["bytes"], ms = t0.elapsed().as_millis()),
        Err(e) => log_warn!("offline", "file not saved for offline", board = b, thread = no, kind = k, error = crate::diag::redact(e, &hide)),
    }
    out
}

/// Deletes a saved thread: its folder and its index entry.
#[tauri::command]
pub async fn offline_delete(app: tauri::AppHandle, dir: Option<String>, board: String, no: u64) -> Result<(), String> {
    check_thread(&board, no)?;
    let root = root_of(&app, dir.as_deref())?;
    let hide = [root.display().to_string()];
    let handle = app.clone();
    let (b, t0) = (board.clone(), Instant::now());
    let out = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<OfflineState>();
        let _lock = state.index.lock().unwrap();
        if let Some(folder) = find_thread_dir(&root, &board, no) {
            // find_thread_dir only returns real folders directly inside root
            if folder.parent() != Some(root.as_path()) {
                return Err("That folder is not a saved thread.".to_string());
            }
            std::fs::remove_dir_all(&folder).map_err(|e| format!("deleting {}: {e}", folder.display()))?;
        }
        // its entry goes from index.json; one that cannot be read is left as
        // it is (the folder is gone, and the list comes from the folders)
        if let Ok(Some(index)) = read_index(&root) {
            let kept: Vec<Value> = index.into_iter().filter(|v| !same_thread(v, &board, no)).collect();
            write_index(&root, &kept)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    match &out {
        Ok(()) => log_info!("offline", "saved thread deleted", board = b, thread = no, ms = t0.elapsed().as_millis()),
        Err(e) => log_warn!("offline", "saved thread not deleted", board = b, thread = no, error = crate::diag::redact(e, &hide)),
    }
    out
}

/// "Download all files": one file from the image host into the download
/// folder (Settings → Files, else Downloads/CloverEye), through the same
/// gate as saved threads. Skipped, with no request, when a file of that
/// name and `size` is already there. { status, path }.
#[tauri::command]
pub async fn download_file(app: tauri::AppHandle, url: String, name: String, dir: Option<String>, size: Option<u64>) -> Result<Value, String> {
    let Some(ext) = crate::extra::media_ext(&url) else {
        return Err("Only files from the image host can be saved.".into());
    };
    let folder = match dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) if Path::new(d).is_absolute() => PathBuf::from(d),
        _ => app.path().download_dir().map_err(|e| e.to_string())?.join("CloverEye"),
    };
    // The server's extension, never one from the uploader's name; worked
    // out before the skip check so a re-run finds the same name.
    let name = crate::extra::save_name(&name, ext);
    ensure_dir(&folder)?;
    let same = folder.join(&name);
    if let (Some(s), Ok(m)) = (size.filter(|s| *s > 0), std::fs::symlink_metadata(&same)) {
        if m.is_file() && m.len() == s {
            log_debug!("files", "download all: already there; skipped", ext = ext, bytes = s);
            return Ok(json!({ "status": "skipped", "path": same.display().to_string() }));
        }
    }
    let hide = [folder.display().to_string(), name.clone()];
    let (ext, t0) = (ext.to_string(), Instant::now());
    let out = gated(&app, move || {
        let body = download(&url)?;
        let path = write_new(&folder, &name, &body)?;
        log_debug!("files", "download all: file saved", bytes = body.len());
        Ok(json!({ "status": "saved", "path": path.display().to_string() }))
    })
    .await;
    match &out {
        Ok(_) => log_debug!("files", "download all: done", ext = ext, ms = t0.elapsed().as_millis()),
        Err(e) => log_warn!("files", "download all: file not saved", ext = ext, error = crate::diag::redact(e, &hide)),
    }
    out
}

// ------------------------------------------------------- the cesaved: scheme

fn respond_status(responder: UriSchemeResponder, status: StatusCode) {
    responder.respond(Response::builder().status(status).body(Vec::new()).unwrap());
}

/// Serves a saved file to CloverEye's own windows (main, w-*), never to the
/// site's helper or post windows. Supports one byte range, for videos.
pub fn protocol(ctx: UriSchemeContext<'_, tauri::Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let label = ctx.webview_label();
    if label != "main" && !label.starts_with("w-") {
        return respond_status(responder, StatusCode::FORBIDDEN);
    }
    let Some((board, no, rel, mime)) = parse_scheme_path(request.uri().path()) else {
        return respond_status(responder, StatusCode::NOT_FOUND);
    };
    let app = ctx.app_handle().clone();
    let range = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
    std::thread::spawn(move || {
        let root = app.state::<OfflineState>().root.lock().unwrap().clone();
        let Some(root) = root.or_else(|| default_root(&app).ok()) else {
            return respond_status(responder, StatusCode::NOT_FOUND);
        };
        let Some(folder) = find_thread_dir(&root, &board, no) else {
            return respond_status(responder, StatusCode::NOT_FOUND);
        };
        let path = folder.join(&rel);
        let real = |p: &Path| std::fs::symlink_metadata(p).map(|m| !m.file_type().is_symlink()).unwrap_or(false);
        let ok = rel.parent().is_some_and(|sub| real(&folder.join(sub))) && std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file());
        let Some(mut file) = ok.then(|| std::fs::File::open(&path).ok()).flatten() else {
            return respond_status(responder, StatusCode::NOT_FOUND);
        };
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        let base = Response::builder()
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Content-Type-Options", "nosniff");
        if let Some((start, end)) = range.as_deref().and_then(|r| parse_range(r, len)) {
            let mut buf = vec![0; (end - start + 1) as usize];
            if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut buf)).is_err() {
                return respond_status(responder, StatusCode::INTERNAL_SERVER_ERROR);
            }
            let res = base
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .header(header::CONTENT_LENGTH, buf.len())
                .body(buf);
            return responder.respond(res.unwrap());
        }
        let mut buf = Vec::with_capacity(len.min(MAX_FILE) as usize);
        if file.take(MAX_FILE).read_to_end(&mut buf).is_err() {
            return respond_status(responder, StatusCode::INTERNAL_SERVER_ERROR);
        }
        responder.respond(base.status(StatusCode::OK).header(header::CONTENT_LENGTH, buf.len()).body(buf).unwrap());
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_new_never_replaces_a_file() {
        let dir = std::env::temp_dir().join(format!("ce-write-new-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("x.png"), b"old").unwrap();
        let p = write_new(&dir, "x.png", b"new").unwrap();
        assert_eq!(p, dir.join("x-2.png"));
        assert_eq!(std::fs::read(dir.join("x.png")).unwrap(), b"old");
        assert_eq!(std::fs::read(&p).unwrap(), b"new");
        assert_eq!(write_new(&dir, "y.png", b"y").unwrap(), dir.join("y.png"));
        // every numbered name taken: one with the time in it, not x.png again
        for i in 3..10_000 {
            std::fs::write(dir.join(format!("x-{i}.png")), b"").unwrap();
        }
        let p = write_new(&dir, "x.png", b"last").unwrap();
        let name = p.file_name().unwrap().to_str().unwrap().to_string();
        assert!(name.starts_with("x-") && name.ends_with(".png") && name != "x-9999.png", "{name}");
        assert_eq!(std::fs::read(&p).unwrap(), b"last");
        assert_eq!(std::fs::read(dir.join("x.png")).unwrap(), b"old");
        // a dangling link is never written through
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("elsewhere"), dir.join("z.png")).unwrap();
            assert_eq!(write_new(&dir, "z.png", b"z").unwrap(), dir.join("z-2.png"));
            assert!(!dir.join("elsewhere").exists());
        }
        // no temporary files left behind
        let temps = std::fs::read_dir(&dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(TMP_SUFFIX)).count();
        assert_eq!(temps, 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn write_new_reports_a_folder_it_cannot_write() {
        let dir = std::env::temp_dir().join(format!("ce-write-new-missing-{}", std::process::id())).join("no").join("such");
        assert!(write_new(&dir, "x.png", b"1").is_err());
    }

    #[test]
    fn boards_numbers_and_extensions_are_checked() {
        assert!(valid_board("g") && valid_board("3") && valid_board("abcdefghij"));
        assert!(!valid_board("") && !valid_board("G") && !valid_board("abcdefghijk") && !valid_board("../g") && !valid_board("g/"));
        for e in [".jpg", ".png", ".gif", ".webm", ".mp4", ".pdf"] {
            assert!(valid_ext(e));
        }
        for e in ["jpg", ".exe", ".JPG", ".jpg/..", "", ".svg"] {
            assert!(!valid_ext(e), "{e}");
        }
    }

    #[test]
    fn folder_names() {
        assert_eq!(slug("Rust General: /rsg/ #42!"), "rust-general-rsg-42");
        assert_eq!(slug("../../etc/passwd"), "etc-passwd");
        assert_eq!(slug("日本語"), "");
        assert!(slug(&"a".repeat(200)).len() <= 40);
        assert_eq!(thread_dir_name("g", 123, "Hello World"), "g-123-hello-world");
        assert_eq!(thread_dir_name("g", 123, "…"), "g-123");
        assert_eq!(parse_dir_name("g-123-hello-world"), Some(("g".into(), 123)));
        assert_eq!(parse_dir_name("g-123"), Some(("g".into(), 123)));
        assert_eq!(parse_dir_name("g-0"), None);
        assert_eq!(parse_dir_name("G-123"), None);
        assert_eq!(parse_dir_name("g-12x"), None);
        assert_eq!(parse_dir_name("g-123-Bad Name"), None);
        assert_eq!(parse_dir_name("index.json"), None);
        assert_eq!(parse_dir_name(".."), None);
    }

    #[test]
    fn file_paths_stay_in_their_folders() {
        assert_eq!(file_rel("full", 1793731659876000, ".webm").unwrap(), Path::new("files").join("1793731659876000.webm"));
        assert_eq!(file_rel("thumb", 1793731659876000, ".webm").unwrap(), Path::new("thumbs").join("1793731659876000s.jpg"));
        assert!(file_rel("full", 1, ".exe").is_err());
        assert!(file_rel("full", 0, ".jpg").is_err());
        assert!(file_rel("other", 1, ".jpg").is_err());
        assert_eq!(file_url("g", "full", 17, ".png").unwrap(), "https://i.4cdn.org/g/17.png");
        assert_eq!(file_url("g", "thumb", 17, ".png").unwrap(), "https://i.4cdn.org/g/17s.jpg");
        assert!(file_url("../x", "full", 17, ".png").is_err());
        assert!(crate::extra::media_ext(&file_url("wsg", "full", 1793731659876000, ".webm").unwrap()).is_some());
    }

    #[test]
    fn scheme_paths() {
        let (b, n, rel, mime) = parse_scheme_path("/g/123/files/1793731659876000.webm").unwrap();
        assert_eq!((b.as_str(), n, mime), ("g", 123, "video/webm"));
        assert_eq!(rel, Path::new("files").join("1793731659876000.webm"));
        // what convertFileSrc sends: the whole path percent-encoded
        let (_, _, rel, mime) = parse_scheme_path("/g%2F123%2Fthumbs%2F1793731659876000s.jpg").unwrap();
        assert_eq!((rel, mime), (Path::new("thumbs").join("1793731659876000s.jpg"), "image/jpeg"));
        for bad in [
            "/g/123/files/../../x.jpg",
            "/g/123/files/..%2F..%2Fx.jpg",
            "/g%2F123%2Ffiles%2F..%2F1.jpg",
            "/g/123/files/1.exe",
            "/g/123/files/1.jpg/x",
            "/g/123/other/1.jpg",
            "/G/123/files/1.jpg",
            "/g/0/files/1.jpg",
            "/g/abc/files/1.jpg",
            "/g/123/thumbs/1.jpg",
            "/g/123/files/.jpg",
            "/g/123/files/1.jpg.png",
            "/g/123/files/123456789012345678901.jpg",
            "/g/123/files/%ZZ.jpg",
            "/g/123/thread.json",
            "/index.json",
        ] {
            assert!(parse_scheme_path(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-", 10), Some((0, 9)));
        assert_eq!(parse_range("bytes=2-5", 10), Some((2, 5)));
        assert_eq!(parse_range("bytes=2-50", 10), Some((2, 9)));
        assert_eq!(parse_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(parse_range("bytes=10-", 10), None);
        assert_eq!(parse_range("bytes=5-2", 10), None);
        assert_eq!(parse_range("bytes=0-1,4-5", 10), None);
        assert_eq!(parse_range("items=0-1", 10), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
        let big = 100 * 1024 * 1024;
        assert_eq!(parse_range("bytes=0-", big), Some((0, RANGE_CHUNK - 1)));
    }

    #[test]
    fn saved_thread_folders_are_found_only_inside_the_root() {
        let root = std::env::temp_dir().join(format!("ce-offline-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("g-123-some-title")).unwrap();
        std::fs::create_dir_all(root.join("g-1234")).unwrap();
        std::fs::write(root.join("g-99"), b"a file, not a folder").unwrap();
        assert_eq!(find_thread_dir(&root, "g", 123), Some(root.join("g-123-some-title")));
        assert_eq!(find_thread_dir(&root, "g", 1234), Some(root.join("g-1234")));
        assert_eq!(find_thread_dir(&root, "g", 12), None);
        assert_eq!(find_thread_dir(&root, "g", 99), None);
        assert_eq!(find_thread_dir(&root, "v", 123), None);
        #[cfg(unix)]
        {
            let outside = std::env::temp_dir().join(format!("ce-offline-out-{}", std::process::id()));
            std::fs::create_dir_all(&outside).unwrap();
            std::os::unix::fs::symlink(&outside, root.join("v-5")).unwrap();
            assert_eq!(find_thread_dir(&root, "v", 5), None, "a link out of the folder is not followed");
            assert!(real_dir(&root.join("v-5")).is_err());
            std::fs::remove_dir_all(&outside).unwrap();
        }
        // the index round-trips
        write_index(&root, &[json!({ "board": "g", "no": 123, "title": "t", "savedAt": 5 })]).unwrap();
        let idx = read_index(&root).unwrap().unwrap();
        assert!(same_thread(&idx[0], "g", 123) && !same_thread(&idx[0], "g", 1234));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_index_that_cannot_be_read_is_never_taken_for_an_empty_one() {
        let root = std::env::temp_dir().join(format!("ce-offline-index-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(read_index(&root), Ok(None), "none yet");
        assert!(index_entries(&root).is_empty());
        let p = root.join(INDEX);
        for bad in [&b"{\"threads\": ["[..], b"[1, 2]", b"{\"version\": 1}", b""] {
            std::fs::write(&p, bad).unwrap();
            assert_eq!(read_index(&root), Err(INDEX_UNREADABLE.to_string()), "{}", String::from_utf8_lossy(bad));
            assert!(index_entries(&root).is_empty(), "shown as no entries");
        }
        // larger than the cap: refused without being read whole (a sparse file)
        std::fs::File::create(&p).unwrap().set_len(MAX_INDEX as u64 + 1).unwrap();
        assert_eq!(read_index(&root), Err(INDEX_UNREADABLE.to_string()));
        assert_eq!(std::fs::metadata(&p).unwrap().len(), MAX_INDEX as u64 + 1, "left as it is");
        std::fs::remove_file(&p).unwrap();
        std::fs::create_dir(&p).unwrap();
        assert!(read_index(&root).is_err(), "a folder in its place");
        std::fs::remove_dir(&p).unwrap();
        std::fs::write(&p, br#"{"version":1,"threads":[{"board":"g","no":5}]}"#).unwrap();
        assert_eq!(read_index(&root).unwrap().unwrap().len(), 1);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn capped_reads_stop_past_the_cap() {
        let dir = std::env::temp_dir().join(format!("ce-capped-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a"), b"12345").unwrap();
        assert_eq!(read_capped(&dir.join("a"), 5).unwrap(), Some(b"12345".to_vec()));
        assert_eq!(read_capped(&dir.join("a"), 4).unwrap(), None);
        assert_eq!(read_capped(&dir.join("none"), 4).unwrap_err().kind(), std::io::ErrorKind::NotFound);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn writes_never_touch_a_file_or_link_of_the_temporary_name() {
        let dir = std::env::temp_dir().join(format!("ce-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // the person's own notes.part, and the old temp name as a link
        std::fs::write(dir.join("notes.part"), b"mine").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("elsewhere"), dir.join("thread.part")).unwrap();
        write_atomic(&dir.join("notes.jpg"), b"image").unwrap();
        write_atomic(&dir.join("thread.json"), b"{}").unwrap();
        assert_eq!(std::fs::read(dir.join("notes.part")).unwrap(), b"mine");
        assert_eq!(std::fs::read(dir.join("notes.jpg")).unwrap(), b"image");
        assert!(!dir.join("elsewhere").exists());
        let temps = std::fs::read_dir(&dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(TMP_SUFFIX)).count();
        assert_eq!(temps, 0);
        // a leftover temporary file is not listed as a saved file
        std::fs::write(dir.join(format!(".x.jpg.1-0-0{TMP_SUFFIX}")), b"half").unwrap();
        let (names, _) = dir_files(&dir);
        assert!(names.iter().all(|n| !n.ends_with(TMP_SUFFIX)));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
