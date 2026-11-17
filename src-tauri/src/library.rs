// The library (meme gallery): files kept on purpose, with where they came
// from, tags and collections.
//
// Layout, inside one folder (Settings → Files → Library; by default
// <Downloads>/CloverEye/Library):
//
//   library.json        the index: one entry per file (written by the UI)
//   <board>/<name>      files saved from a thread on that board
//   imported/<name>     files brought in from elsewhere
//
// The index's contents are the UI's business (tags, source post, hashes);
// here it is read and written whole, atomically. Several windows each keep
// a copy, so a write carries the index's revision (`rev`): it lands only
// on the revision it was made from (one more than the file's), else it is
// refused as "changed in another window" and that window merges the file's
// list with its own changes and writes again. A library.json that cannot
// be read is never replaced. Files come from the image
// host through the same 1 s gate as every download, or from the person's
// own disk (an import: the bytes come from the UI). Every path is built
// here from checked parts: a board or "imported", then a cleaned file name
// with an extension from a short list; never a path the UI sends.
//
// Files are shown back through the app's own `celib:` scheme, which serves
// only <library>/<sub>/<name> to CloverEye's own windows (see offline.rs for
// why not Tauri's asset protocol). It allows any origin to read (CORS), so
// the UI can draw a file on a canvas for its look-alike hash.

use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};

use serde_json::{json, Value};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Emitter, Manager, UriSchemeContext, UriSchemeResponder};

pub const SCHEME: &str = "celib";
const INDEX: &str = "library.json";
const IMPORTED: &str = "imported";
const EXTS: [&str; 8] = ["jpg", "jpeg", "png", "gif", "webp", "webm", "mp4", "pdf"];
const MAX_FILE: usize = 64 * 1024 * 1024;
const MAX_INDEX: usize = 32 * 1024 * 1024;

#[derive(Default)]
pub struct LibraryState {
    /// The folder last used, for the `celib:` scheme.
    root: Mutex<Option<PathBuf>>,
    /// library.json is written under this.
    index: Mutex<()>,
}

fn default_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().download_dir().map_err(|e| e.to_string())?.join("CloverEye").join("Library"))
}

/// The library folder: Settings' (absolute paths only) or the default.
fn root_of(app: &tauri::AppHandle, dir: Option<&str>) -> Result<PathBuf, String> {
    let root = match dir.map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) if Path::new(d).is_absolute() && !d.contains('\0') => PathBuf::from(d),
        Some(_) => return Err("The library folder must be a full path.".into()),
        None => default_root(app)?,
    };
    *app.state::<LibraryState>().root.lock().unwrap() = Some(root.clone());
    Ok(root)
}

fn ensure_dir(p: &Path) -> Result<(), String> {
    match std::fs::metadata(p) {
        Ok(m) if m.is_dir() => Ok(()),
        Ok(_) => Err(format!("{} is not a folder.", p.display())),
        Err(_) => std::fs::create_dir_all(p).map_err(|e| format!("creating {}: {e}", p.display())),
    }
}

/// A sub-folder made by CloverEye: a real folder, never a link.
fn real_sub(root: &Path, sub: &str) -> Result<PathBuf, String> {
    let p = root.join(sub);
    match std::fs::symlink_metadata(&p) {
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() => Ok(p),
        Ok(_) => Err(format!("{} is not a folder.", p.display())),
        Err(_) => std::fs::create_dir(&p).map(|_| p.clone()).map_err(|e| format!("creating {}: {e}", p.display())),
    }
}

fn valid_sub(s: &str) -> bool {
    s == IMPORTED || crate::offline::valid_board(s)
}

fn ext_of(name: &str) -> Option<String> {
    let (_, e) = name.rsplit_once('.')?;
    let e = e.to_ascii_lowercase();
    EXTS.contains(&e.as_str()).then_some(e)
}

/// Longest name a library file is given, before a "-N" for a name taken.
const NAME_BYTES: usize = 144;
/// Longest name the `celib:` scheme and deletes accept (with "-N", or the
/// time the name helper puts in when every "-N" is taken).
const REL_NAME_BYTES: usize = 220;

/// A name for the library: cleaned, with an extension it can show. A long
/// name is cut in its stem, so the extension stays, and short enough that
/// a "-2"... added for a name already taken still reads back.
fn file_name(name: &str) -> Result<String, String> {
    let bad = || "Only pictures, GIFs, videos (WebM, MP4) and PDFs go in the library.".to_string();
    ext_of(name).ok_or_else(bad)?;
    let (stem, ext) = name.rsplit_once('.').ok_or_else(bad)?;
    let stem = crate::extra::safe_name(stem);
    let mut cut = stem.len().min(NAME_BYTES - 1 - ext.len());
    while !stem.is_char_boundary(cut) {
        cut -= 1;
    }
    let stem = stem[..cut].trim_end_matches(['.', ' ']).trim_start_matches(['.', ' ']);
    Ok(format!("{}.{ext}", if stem.is_empty() { "file" } else { stem }))
}

/// A name as the app writes them: no separators or control characters, no
/// dot or space at either end.
fn clean_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= REL_NAME_BYTES
        && name.trim() == name
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
}

/// "<sub>/<name>" from the UI, checked part by part.
fn parse_rel(rel: &str) -> Option<(String, String)> {
    let (sub, name) = rel.split_once('/')?;
    if !valid_sub(sub) || !clean_name(name) {
        return None;
    }
    ext_of(name)?;
    Some((sub.to_string(), name.to_string()))
}

fn mime(name: &str) -> &'static str {
    match ext_of(name).as_deref() {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("webm") => "video/webm",
        Some("mp4") => "video/mp4",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Writes the bytes as a new file in <root>/<sub>: { rel, bytes }.
fn store(root: &Path, sub: &str, name: &str, body: &[u8]) -> Result<Value, String> {
    ensure_dir(root)?;
    let folder = real_sub(root, sub)?;
    // a new name each time: two saves at once never share a file
    let path = crate::offline::write_new(&folder, name, body)?;
    let saved = path.file_name().and_then(|n| n.to_str()).unwrap_or(name);
    Ok(json!({ "rel": format!("{sub}/{saved}"), "bytes": body.len() }))
}

/// Refused writes say this; the UI then merges and writes again.
const CHANGED: &str = "The library changed in another window.";

/// library.json's bytes as they are on disk: None when there is none yet;
/// an error when it cannot be read or is larger than MAX_INDEX.
fn index_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Couldn’t read library.json: {e}")),
    };
    let mut bytes = Vec::new();
    file.take(MAX_INDEX as u64 + 1).read_to_end(&mut bytes).map_err(|e| format!("Couldn’t read library.json: {e}"))?;
    if bytes.len() > MAX_INDEX {
        return Err("library.json is larger than CloverEye reads (32 MB). It was left as it is.".into());
    }
    Ok(Some(bytes))
}

/// The error for a library.json that is not JSON (written so the i18n
/// scanner finds it).
fn damaged<T>() -> Result<T, String> {
    Err("library.json is damaged. It was left as it is: fix or move it, then try again.".into())
}

/// library.json as it is on disk: None when there is none yet; an error
/// when it cannot be read, is larger than MAX_INDEX or is not JSON (it is
/// then left as it is, never taken for an empty library).
fn read_index(path: &Path) -> Result<Option<Value>, String> {
    let Some(bytes) = index_bytes(path)? else { return Ok(None) };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(v) => Ok(Some(v)),
        Err(_) => damaged(),
    }
}

/// Only the revision of library.json: None when there is none yet,
/// Some(None) when it has no revision (an older CloverEye, or not an
/// object). The rest of the file is checked as JSON but not kept, so a
/// write does not build the whole index in memory again.
fn read_rev(path: &Path) -> Result<Option<Option<u64>>, String> {
    #[derive(serde::Deserialize)]
    struct Rev {
        rev: Option<Value>,
    }
    let Some(bytes) = index_bytes(path)? else { return Ok(None) };
    // an object only: a struct would also read a list ([5]) by position
    let object = bytes.iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'{');
    if let Some(r) = object.then(|| serde_json::from_slice::<Rev>(&bytes).ok()).flatten() {
        return Ok(Some(r.rev.as_ref().and_then(Value::as_u64)));
    }
    // JSON of another shape has no revision; anything else is damaged
    match serde_json::from_slice::<serde::de::IgnoredAny>(&bytes) {
        Ok(_) => Ok(Some(None)),
        Err(_) => damaged(),
    }
}

fn rev_of(index: &Value) -> Option<u64> {
    index.get("rev").and_then(Value::as_u64)
}

/// The library's folder and its index (null when there is none yet).
#[tauri::command]
pub async fn library_load(app: tauri::AppHandle, dir: Option<String>) -> Result<Value, String> {
    let root = root_of(&app, dir.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let index = read_index(&root.join(INDEX))?.unwrap_or(Value::Null);
        Ok(json!({ "root": root.display().to_string(), "index": index }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whether `next` may replace the file whose revision is `disk` (see
/// read_rev): the file is missing, or `next` was made from the file's
/// revision (one more than it). An index without a revision (an older
/// CloverEye) is always written.
fn may_replace(disk: Option<Option<u64>>, next: &Value) -> bool {
    match (disk, rev_of(next)) {
        (None, _) | (_, None) => true,
        (Some(d), Some(n)) => n == d.unwrap_or(0) + 1,
    }
}

/// Writes the whole index, unless another window wrote first (see the top).
#[tauri::command]
pub async fn library_save(app: tauri::AppHandle, dir: Option<String>, index: Value) -> Result<(), String> {
    let root = root_of(&app, dir.as_deref())?;
    let bytes = serde_json::to_vec(&index).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_INDEX {
        return Err("The library index is too large.".into());
    }
    let handle = app.clone();
    let rev = rev_of(&index);
    let at = root.display().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<LibraryState>();
        let _lock = state.index.lock().unwrap();
        ensure_dir(&root)?;
        let path = root.join(INDEX);
        // a file that cannot be read is kept: the error says why
        let disk = match read_rev(&path) {
            Ok(d) => d,
            Err(_) => return Err("library.json can’t be read, so it was not replaced.".to_string()),
        };
        if !may_replace(disk, &index) {
            return Err(CHANGED.to_string());
        }
        crate::offline::write_atomic(&path, &bytes)
    })
    .await
    .map_err(|e| e.to_string())??;
    // the other windows can read it again
    let _ = app.emit("library-changed", json!({ "root": at, "rev": rev }));
    Ok(())
}

/// One file from the image host into <library>/<board>/: { rel, bytes }.
#[tauri::command]
pub async fn library_fetch(app: tauri::AppHandle, dir: Option<String>, url: String, board: String, name: String) -> Result<Value, String> {
    let Some(ext) = crate::extra::media_ext(&url).filter(|_| url.starts_with(&format!("https://i.4cdn.org/{board}/"))) else {
        return Err("Only files from the image host can be saved.".into());
    };
    if !crate::offline::valid_board(&board) {
        return Err("Not a board.".into());
    }
    // the server's extension, never the uploader's: a post named x.png
    // whose file is a .jpg is kept as x.png.jpg, so celib: serves it as one
    let name = file_name(&crate::extra::save_name(&name, ext))?;
    let root = root_of(&app, dir.as_deref())?;
    crate::offline::gated(&app, move || {
        let body = crate::offline::download(&url)?;
        store(&root, &board, &name, &body)
    })
    .await
}

/// A file from the person's disk, sent as the request's raw body, its name
/// in the "x-name" header (URI-encoded) and the library folder in "x-dir":
/// into <library>/imported/. { rel, bytes }.
#[tauri::command]
pub async fn library_import(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("No file came.".into());
    };
    if body.is_empty() || body.len() > MAX_FILE {
        return Err("The file is empty or larger than CloverEye keeps (64 MB).".into());
    }
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(uri_decode);
    let name = file_name(&header("x-name").unwrap_or_default())?;
    let root = root_of(&app, header("x-dir").as_deref())?;
    let body = body.clone();
    tauri::async_runtime::spawn_blocking(move || store(&root, IMPORTED, &name, &body))
        .await
        .map_err(|e| e.to_string())?
}

/// Deletes one file of the library (the index is the UI's to update).
#[tauri::command]
pub async fn library_delete(app: tauri::AppHandle, dir: Option<String>, rel: String) -> Result<(), String> {
    let (sub, name) = parse_rel(&rel).ok_or("Not a library file.")?;
    let root = root_of(&app, dir.as_deref())?;
    let path = root.join(&sub).join(&name);
    match std::fs::symlink_metadata(&path) {
        Ok(m) if m.is_file() => std::fs::remove_file(&path).map_err(|e| format!("deleting {}: {e}", path.display())),
        Ok(_) => Err(format!("{} is not a file.", path.display())),
        Err(_) => Ok(()), // already gone
    }
}

// ------------------------------------------------- importing a folder

/// How many files one folder import brings in at most.
const MAX_IMPORT: usize = 5000;

fn media(p: &Path) -> bool {
    p.file_name().and_then(|n| n.to_str()).is_some_and(|n| !n.starts_with('.') && ext_of(n).is_some_and(|e| e != "pdf"))
}

/// A folder of the person's own to look into: a full path, a real folder.
fn real_folder(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_absolute() || path.contains('\0') {
        return Err("Not a full folder path.".into());
    }
    match std::fs::metadata(&p) {
        Ok(m) if m.is_dir() => Ok(p),
        _ => Err(format!("{} is not a folder.", p.display())),
    }
}

/// One folder's sub-folders and how many pictures and videos it holds, for
/// the in-app folder browser: { path, parent, dirs: [{ name, path }],
/// media, places: [{ name, path }] }. Hidden folders are left out.
#[tauri::command]
pub async fn library_browse(app: tauri::AppHandle, path: Option<String>) -> Result<Value, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let mut places = vec![json!({ "name": "Home", "path": home.display().to_string() })];
    for (name, dir) in [
        ("Pictures", app.path().picture_dir().ok()),
        ("Downloads", app.path().download_dir().ok()),
        ("Desktop", app.path().desktop_dir().ok()),
        ("Documents", app.path().document_dir().ok()),
    ] {
        if let Some(d) = dir.filter(|d| d.is_dir()) {
            places.push(json!({ "name": name, "path": d.display().to_string() }));
        }
    }
    #[cfg(target_os = "macos")]
    if let Ok(rd) = std::fs::read_dir("/Volumes") {
        for e in rd.flatten() {
            places.push(json!({ "name": e.file_name().to_string_lossy(), "path": e.path().display().to_string() }));
        }
    }
    let dir = match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => real_folder(p)?,
        None => home,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut dirs = Vec::new();
        let mut count = 0usize;
        let rd = std::fs::read_dir(&dir).map_err(|e| format!("opening {}: {e}", dir.display()))?;
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            // a link to a folder is followed for looking, like the Finder
            if std::fs::metadata(&p).is_ok_and(|m| m.is_dir()) {
                dirs.push((name, p));
            } else if media(&p) {
                count += 1;
            }
        }
        dirs.sort_by_key(|(n, _)| n.to_lowercase());
        Ok(json!({
            "path": dir.display().to_string(),
            "parent": dir.parent().map(|p| p.display().to_string()),
            "dirs": dirs.into_iter().map(|(name, p)| json!({ "name": name, "path": p.display().to_string() })).collect::<Vec<_>>(),
            "media": count,
            "places": places,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A file's path inside the folder imported (`base`), as `from` and `skip`
/// hold it.
fn inside(base: &Path, p: &Path) -> String {
    p.strip_prefix(base).map(|r| r.display().to_string()).unwrap_or_default()
}

/// The pictures and videos of a folder `base` (and its sub-folders when
/// `deep`), links not followed, leaving out those in `skip` (paths inside
/// `base`), at most MAX_IMPORT. True when a file was left out past that.
fn collect(base: &Path, dir: &Path, deep: bool, skip: &HashSet<String>, out: &mut Vec<PathBuf>) -> bool {
    let Ok(rd) = std::fs::read_dir(dir) else { return false };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let p = e.path();
        let Ok(m) = std::fs::symlink_metadata(&p) else { continue };
        if e.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if m.is_dir() {
            if deep && collect(base, &p, deep, skip, out) {
                return true;
            }
        } else if m.is_file() && m.len() > 0 && m.len() <= MAX_FILE as u64 && media(&p) && !skip.contains(&inside(base, &p)) {
            // the skipped ones do not count: a rescan goes on past them
            if out.len() >= MAX_IMPORT {
                return true;
            }
            out.push(p);
        }
    }
    false
}

/// Copies a folder's pictures and videos into <library>/imported/:
/// { items: [{ rel, name, from, bytes }], more } (`from`: the path inside
/// the folder; `more`: files left out past the limit). `skip`: paths inside
/// the folder already brought in or left out (a rescan takes only what is
/// new, and goes on past the limit). The UI then checks each for a copy
/// already kept, and fingerprints it. The folder itself is only read.
#[tauri::command]
pub async fn library_import_dir(app: tauri::AppHandle, dir: Option<String>, src: String, deep: bool, skip: Option<Vec<String>>) -> Result<Value, String> {
    let skip: HashSet<String> = skip.unwrap_or_default().into_iter().collect();
    let from = real_folder(&src)?;
    let root = root_of(&app, dir.as_deref())?;
    if root.starts_with(&from) || from.starts_with(&root) {
        return Err("That folder is, or holds, the library itself.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        let more = collect(&from, &from, deep, &skip, &mut files);
        let mut items = Vec::new();
        for p in files {
            // the same checked name as every other way in (stem cut, extension kept)
            let Some(name) = p.file_name().and_then(|n| n.to_str()).and_then(|n| file_name(n).ok()) else { continue };
            let Ok(body) = std::fs::read(&p) else { continue };
            let Ok(v) = store(&root, IMPORTED, &name, &body) else { continue };
            items.push(json!({ "rel": v["rel"], "name": name, "from": inside(&from, &p), "bytes": body.len() }));
        }
        Ok(json!({ "items": items, "more": more }))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn uri_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------- the celib: scheme

fn respond_status(responder: UriSchemeResponder, status: StatusCode) {
    responder.respond(Response::builder().status(status).header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*").body(Vec::new()).unwrap());
}

/// How many library files are read at once (a grid of videos asks for many).
const READS_AT_ONCE: usize = 8;
static READS: (Mutex<usize>, Condvar) = (Mutex::new(0), Condvar::new());

/// One of READS_AT_ONCE turns to read a file, given back when dropped.
struct ReadTurn;

impl ReadTurn {
    fn take() -> Self {
        let (lock, cv) = &READS;
        let mut n = lock.lock().unwrap_or_else(|e| e.into_inner());
        while *n >= READS_AT_ONCE {
            n = cv.wait(n).unwrap_or_else(|e| e.into_inner());
        }
        *n += 1;
        ReadTurn
    }
}

impl Drop for ReadTurn {
    fn drop(&mut self) {
        let (lock, cv) = &READS;
        let mut n = lock.lock().unwrap_or_else(|e| e.into_inner());
        *n = n.saturating_sub(1);
        cv.notify_one();
    }
}

/// What a request asks for: one byte range (videos), and the version it
/// already holds (If-None-Match).
#[derive(Default)]
struct Ask {
    range: Option<String>,
    etag: Option<String>,
    /// The address names the file's content (`?v=<md5>`, as the UI asks):
    /// it may be kept as it is.
    pinned: bool,
}

/// A file's version: its length and when it was last written.
fn etag_of(m: &std::fs::Metadata) -> String {
    let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
    format!("\"{:x}-{t:x}\"", m.len())
}

/// The answer for <root>/<sub>/<name>: the file (or the range asked, at most
/// RANGE_CHUNK), 304 when the window holds this version, 404 when it is
/// not a real file of the library.
fn answer(root: &Path, sub: &str, name: &str, ask: &Ask) -> Response<Vec<u8>> {
    let status = |s: StatusCode| Response::builder().status(s).header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*").body(Vec::new()).unwrap();
    let folder = root.join(sub);
    let path = folder.join(name);
    let real = std::fs::symlink_metadata(&folder).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
        && std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file());
    let Some(mut file) = real.then(|| std::fs::File::open(&path).ok()).flatten() else {
        return status(StatusCode::NOT_FOUND);
    };
    let Ok(meta) = file.metadata() else {
        return status(StatusCode::NOT_FOUND);
    };
    let len = meta.len();
    let etag = etag_of(&meta);
    let base = || {
        Response::builder()
            .header(header::CONTENT_TYPE, mime(name))
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ETAG, etag.as_str())
            // a library file never changes under its name and content; asked
            // without the content in the address, the window checks first
            .header(header::CACHE_CONTROL, if ask.pinned { "private, max-age=31536000, immutable" } else { "private, no-cache" })
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header("X-Content-Type-Options", "nosniff")
    };
    if ask.etag.as_deref().is_some_and(|t| t.split(',').any(|x| x.trim() == etag || x.trim() == "*")) {
        return base().status(StatusCode::NOT_MODIFIED).body(Vec::new()).unwrap();
    }
    let _turn = ReadTurn::take();
    if let Some((start, end)) = ask.range.as_deref().and_then(|r| crate::offline::parse_range(r, len)) {
        let mut buf = vec![0; (end - start + 1) as usize];
        if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut buf)).is_err() {
            return status(StatusCode::INTERNAL_SERVER_ERROR);
        }
        return base()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
            .header(header::CONTENT_LENGTH, buf.len())
            .body(buf)
            .unwrap();
    }
    // no range: the whole file (a picture, or the UI reading it to hash)
    let mut buf = Vec::with_capacity(len.min(MAX_FILE as u64) as usize);
    if file.take(MAX_FILE as u64).read_to_end(&mut buf).is_err() {
        return status(StatusCode::INTERNAL_SERVER_ERROR);
    }
    base().status(StatusCode::OK).header(header::CONTENT_LENGTH, buf.len()).body(buf).unwrap()
}

/// Serves a library file to CloverEye's own windows (main, w-*). Path:
/// /<sub>/<name>, URI-encoded. One byte range at a time for videos, so a
/// grid of them never reads each whole; a few files are read at once.
pub fn protocol(ctx: UriSchemeContext<'_, tauri::Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let label = ctx.webview_label();
    if label != "main" && !label.starts_with("w-") {
        return respond_status(responder, StatusCode::FORBIDDEN);
    }
    let rel = uri_decode(request.uri().path().trim_start_matches('/'));
    let Some((sub, name)) = parse_rel(&rel) else {
        return respond_status(responder, StatusCode::NOT_FOUND);
    };
    let text = |k: header::HeaderName| request.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
    let ask = Ask {
        range: text(header::RANGE),
        etag: text(header::IF_NONE_MATCH),
        pinned: request.uri().query().is_some_and(|q| q.split('&').any(|p| p.strip_prefix("v=").is_some_and(|v| v.len() == 32 && v.bytes().all(|c| c.is_ascii_hexdigit())))),
    };
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = app.state::<LibraryState>().root.lock().unwrap().clone();
        let Some(root) = root.or_else(|| default_root(&app).ok()) else {
            return respond_status(responder, StatusCode::NOT_FOUND);
        };
        responder.respond(answer(&root, &sub, &name, &ask));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_paths_are_checked() {
        assert_eq!(parse_rel("g/frog.png"), Some(("g".into(), "frog.png".into())));
        assert_eq!(parse_rel("imported/a b.JPG"), Some(("imported".into(), "a b.JPG".into())));
        for bad in ["../g/x.png", "g/../x.png", "G/x.png", "g/x.exe", "g/.x.png", "g/sub/x.png", "x.png", "g/x\\y.png", "e-t/x.png"] {
            assert_eq!(parse_rel(bad), None, "{bad}");
        }
    }

    #[test]
    fn names_need_a_known_extension() {
        assert_eq!(file_name("pepe.webp").unwrap(), "pepe.webp");
        assert_eq!(file_name("a/b.gif").unwrap(), "a_b.gif");
        assert!(file_name("notes.txt").is_err());
        assert!(file_name("").is_err());
    }

    #[test]
    fn files_from_the_site_keep_the_servers_extension() {
        // as library_fetch names them: save_name, then file_name
        let fetched = |name: &str, url: &str| file_name(&crate::extra::save_name(name, crate::extra::media_ext(url).unwrap()));
        assert_eq!(fetched("frog.png", "https://i.4cdn.org/g/1793731659876000.jpg").unwrap(), "frog.png.jpg");
        assert_eq!(fetched("frog.jpg", "https://i.4cdn.org/g/1793731659876000.jpg").unwrap(), "frog.jpg");
        assert_eq!(fetched("notes.txt", "https://i.4cdn.org/g/1793731659876000.webm").unwrap(), "notes.txt.webm");
        // a long name, and one hiding .hta past the cut, still end in .jpg
        let long = fetched(&format!("{}.jpg", "日".repeat(60)), "https://i.4cdn.org/g/1793731659876000.jpg").unwrap();
        assert!(long.ends_with(".jpg") && long.len() <= NAME_BYTES, "{long}");
        let sly = fetched(&format!("{}.hta{}", "A".repeat(116), "z".repeat(40)), "https://i.4cdn.org/g/1793731659876000.jpg").unwrap();
        assert!(sly.ends_with(".jpg") && sly.len() <= NAME_BYTES, "{sly}");
        assert_eq!(mime(&sly), "image/jpeg");
        assert!(parse_rel(&format!("g/{long}")).is_some() && parse_rel(&format!("g/{sly}")).is_some());
    }

    #[test]
    fn a_folder_import_takes_pictures_and_videos_only() {
        let base = std::env::temp_dir().join(format!("ce-lib-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("sub")).unwrap();
        for (n, b) in [("a.png", "x"), ("b.txt", "x"), (".c.jpg", "x"), ("e.webm", ""), ("d.pdf", "x")] {
            std::fs::write(base.join(n), b).unwrap();
        }
        std::fs::write(base.join("sub/f.gif"), "x").unwrap();
        let names = |deep| {
            let mut v = Vec::new();
            assert!(!collect(&base, &base, deep, &HashSet::new(), &mut v));
            v.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect::<Vec<_>>()
        };
        assert_eq!(names(false), ["a.png"]);
        assert_eq!(names(true), ["a.png", "f.gif"]);
        let mut v = Vec::new();
        let skip: HashSet<String> = [inside(&base, &base.join("a.png"))].into_iter().collect();
        assert!(!collect(&base, &base, true, &skip, &mut v));
        assert_eq!(v, [base.join("sub/f.gif")], "paths inside the folder are skipped");
        assert!(real_folder("relative/path").is_err());
        assert!(real_folder(base.join("a.png").to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_rescan_goes_on_past_the_limit() {
        let base = std::env::temp_dir().join(format!("ce-lib-many-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        for i in 0..MAX_IMPORT + 3 {
            std::fs::write(base.join(format!("{i:05}.png")), "x").unwrap();
        }
        let mut first = Vec::new();
        assert!(collect(&base, &base, true, &HashSet::new(), &mut first), "more were left out");
        assert_eq!(first.len(), MAX_IMPORT);
        let skip: HashSet<String> = first.iter().map(|p| inside(&base, p)).collect();
        let mut next = Vec::new();
        assert!(!collect(&base, &base, true, &skip, &mut next), "nothing left out this time");
        assert_eq!(next.len(), 3, "the rescan brings the rest");
        // exactly the limit: nothing is left out
        let skip3: HashSet<String> = next.iter().map(|p| inside(&base, p)).collect();
        let mut all = Vec::new();
        assert!(!collect(&base, &base, true, &skip3, &mut all));
        assert_eq!(all.len(), MAX_IMPORT);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn long_names_keep_their_extension_and_read_back() {
        let long = format!("{}.jpg", "日本語".repeat(20)); // 180 bytes + .jpg
        let n = file_name(&long).unwrap();
        assert!(n.ends_with(".jpg") && n.len() <= NAME_BYTES, "{n}");
        assert!(parse_rel(&format!("imported/{n}")).is_some());
        // a name taken: "-2"... still reads back, and can be deleted
        let (stem, ext) = n.rsplit_once('.').unwrap();
        assert!(parse_rel(&format!("imported/{stem}-9999.{ext}")).is_some());
        assert_eq!(file_name(".png").unwrap(), "file.png");
        assert_eq!(file_name("a b.JPG").unwrap(), "a b.JPG");
        for bad in ["imported/ x.png", "imported/x.png.", "imported/x:y.png", "imported/a\u{7}.png"] {
            assert_eq!(parse_rel(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_write_lands_only_on_the_revision_it_came_from() {
        let disk = Some(Some(4));
        assert!(may_replace(disk, &json!({ "rev": 5 })));
        assert!(!may_replace(disk, &json!({ "rev": 4 })), "another window wrote rev 4 first");
        assert!(!may_replace(disk, &json!({ "rev": 7 })));
        assert!(may_replace(None, &json!({ "rev": 9 })), "no file yet");
        assert!(may_replace(Some(None), &json!({ "rev": 1 })), "a file from before revisions");
        assert!(may_replace(disk, &json!({ "items": [] })), "an index without a revision");
    }

    #[test]
    fn a_write_reads_only_the_files_revision() {
        let base = std::env::temp_dir().join(format!("ce-lib-rev-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let p = base.join(INDEX);
        assert_eq!(read_rev(&p).unwrap(), None, "none yet");
        std::fs::write(&p, r#"{"version":1,"items":[{"id":"a","tags":["x"]}],"rev":7,"folders":{}}"#).unwrap();
        assert_eq!(read_rev(&p).unwrap(), Some(Some(7)));
        std::fs::write(&p, r#"{"items":[]}"#).unwrap();
        assert_eq!(read_rev(&p).unwrap(), Some(None), "from before revisions");
        std::fs::write(&p, r#"{"rev":"x","items":[]}"#).unwrap();
        assert_eq!(read_rev(&p).unwrap(), Some(None), "a revision that is not one");
        std::fs::write(&p, "[5]").unwrap();
        assert_eq!(read_rev(&p).unwrap(), Some(None), "JSON of another shape");
        std::fs::write(&p, "{\"rev\": 3, \"items\": [").unwrap();
        assert!(read_rev(&p).is_err(), "damaged");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_index_that_cannot_be_read_is_an_error_not_an_empty_library() {
        let base = std::env::temp_dir().join(format!("ce-lib-index-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let p = base.join(INDEX);
        assert_eq!(read_index(&p).unwrap(), None, "none yet");
        std::fs::write(&p, "{\"items\": [").unwrap();
        assert!(read_index(&p).is_err(), "damaged");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{\"items\": [", "left as it is");
        std::fs::write(&p, "{\"rev\": 2}").unwrap();
        assert_eq!(read_index(&p).unwrap(), Some(json!({ "rev": 2 })));
        std::fs::create_dir_all(base.join("dir.json")).unwrap();
        assert!(read_index(&base.join("dir.json")).is_err(), "a folder in its place");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn files_are_served_by_range_and_by_version() {
        let base = std::env::temp_dir().join(format!("ce-lib-serve-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("imported")).unwrap();
        let body: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(base.join("imported/v.webm"), &body).unwrap();
        let whole = answer(&base, "imported", "v.webm", &Ask::default());
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(whole.body(), &body);
        assert_eq!(whole.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(whole.headers()[header::CACHE_CONTROL], "private, no-cache");
        let part = answer(&base, "imported", "v.webm", &Ask { range: Some("bytes=100-199".into()), pinned: true, ..Ask::default() });
        assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(part.body(), &body[100..200]);
        assert_eq!(part.headers()[header::CONTENT_RANGE], "bytes 100-199/5000");
        assert!(part.headers()[header::CACHE_CONTROL].to_str().unwrap().contains("immutable"));
        let etag = whole.headers()[header::ETAG].to_str().unwrap().to_string();
        let same = answer(&base, "imported", "v.webm", &Ask { etag: Some(etag), ..Ask::default() });
        assert_eq!(same.status(), StatusCode::NOT_MODIFIED);
        assert!(same.body().is_empty());
        assert_eq!(answer(&base, "imported", "gone.png", &Ask::default()).status(), StatusCode::NOT_FOUND);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn uri_names_decode() {
        assert_eq!(uri_decode("caf%C3%A9%20x.png"), "café x.png");
        assert_eq!(uri_decode("100%.png"), "100%.png");
        assert_eq!(uri_decode("a%2"), "a%2");
    }
}
