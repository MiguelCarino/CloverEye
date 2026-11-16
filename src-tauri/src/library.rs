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
// here it is read and written whole, atomically. Files come from the image
// host through the same 1 s gate as every download, or from the person's
// own disk (an import: the bytes come from the UI). Every path is built
// here from checked parts: a board or "imported", then a cleaned file name
// with an extension from a short list; never a path the UI sends.
//
// Files are shown back through the app's own `celib:` scheme, which serves
// only <library>/<sub>/<name> to CloverEye's own windows (see offline.rs for
// why not Tauri's asset protocol). It allows any origin to read (CORS), so
// the UI can draw a file on a canvas for its look-alike hash.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, UriSchemeContext, UriSchemeResponder};

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

/// A name for the library: cleaned, and with an extension it can show.
fn file_name(name: &str) -> Result<String, String> {
    let n = crate::extra::safe_name(name);
    ext_of(&n).map(|_| n).ok_or_else(|| "Only pictures, GIFs, videos (WebM, MP4) and PDFs go in the library.".to_string())
}

/// "<sub>/<name>" from the UI, checked part by part.
fn parse_rel(rel: &str) -> Option<(String, String)> {
    let (sub, name) = rel.split_once('/')?;
    if !valid_sub(sub) || name.contains('/') || name.contains('\\') || name.starts_with('.') || name != crate::extra::safe_name(name) {
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
    let path = crate::extra::unique_path(&folder, name);
    crate::offline::write_atomic(&path, body)?;
    let saved = path.file_name().and_then(|n| n.to_str()).unwrap_or(name);
    Ok(json!({ "rel": format!("{sub}/{saved}"), "bytes": body.len() }))
}

/// The library's folder and its index (null when there is none yet).
#[tauri::command]
pub async fn library_load(app: tauri::AppHandle, dir: Option<String>) -> Result<Value, String> {
    let root = root_of(&app, dir.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let index = match std::fs::read(root.join(INDEX)) {
            Ok(b) if b.len() <= MAX_INDEX => serde_json::from_slice::<Value>(&b).unwrap_or(Value::Null),
            _ => Value::Null,
        };
        Ok(json!({ "root": root.display().to_string(), "index": index }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Writes the whole index.
#[tauri::command]
pub async fn library_save(app: tauri::AppHandle, dir: Option<String>, index: Value) -> Result<(), String> {
    let root = root_of(&app, dir.as_deref())?;
    let bytes = serde_json::to_vec(&index).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_INDEX {
        return Err("The library index is too large.".into());
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<LibraryState>();
        let _lock = state.index.lock().unwrap();
        ensure_dir(&root)?;
        crate::offline::write_atomic(&root.join(INDEX), &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One file from the image host into <library>/<board>/: { rel, bytes }.
#[tauri::command]
pub async fn library_fetch(app: tauri::AppHandle, dir: Option<String>, url: String, board: String, name: String) -> Result<Value, String> {
    if !crate::extra::media_url_ok(&url) || !url.starts_with(&format!("https://i.4cdn.org/{board}/")) {
        return Err("Only files from the image host can be saved.".into());
    }
    if !crate::offline::valid_board(&board) {
        return Err("Not a board.".into());
    }
    let name = file_name(&name)?;
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

/// The pictures and videos of a folder (and its sub-folders when `deep`),
/// at most MAX_IMPORT, links not followed.
fn collect(dir: &Path, deep: bool, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        if out.len() >= MAX_IMPORT {
            return;
        }
        let p = e.path();
        let Ok(m) = std::fs::symlink_metadata(&p) else { continue };
        if e.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if m.is_dir() {
            if deep {
                collect(&p, deep, out);
            }
        } else if m.is_file() && m.len() > 0 && m.len() <= MAX_FILE as u64 && media(&p) {
            out.push(p);
        }
    }
}

/// Copies a folder's pictures and videos into <library>/imported/:
/// { items: [{ rel, name, from, bytes }], more } (`from`: the path inside
/// the folder; `more`: files left out past the limit). `skip`: paths inside
/// the folder already brought in (a rescan takes only what is new). The UI
/// then checks each for a copy already kept, and fingerprints it.
#[tauri::command]
pub async fn library_import_dir(app: tauri::AppHandle, dir: Option<String>, src: String, deep: bool, skip: Option<Vec<String>>) -> Result<Value, String> {
    let skip: std::collections::HashSet<String> = skip.unwrap_or_default().into_iter().collect();
    let from = real_folder(&src)?;
    let root = root_of(&app, dir.as_deref())?;
    if root.starts_with(&from) || from.starts_with(&root) {
        return Err("That folder is, or holds, the library itself.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        collect(&from, deep, &mut files);
        files.retain(|p| !skip.contains(&p.strip_prefix(&from).map(|r| r.display().to_string()).unwrap_or_default()));
        let more = files.len() >= MAX_IMPORT;
        let mut items = Vec::new();
        for p in files {
            let name = p.file_name().and_then(|n| n.to_str()).map(crate::extra::safe_name).unwrap_or_default();
            let Ok(body) = std::fs::read(&p) else { continue };
            let Ok(v) = store(&root, IMPORTED, &name, &body) else { continue };
            let inside = p.strip_prefix(&from).map(|r| r.display().to_string()).unwrap_or(name.clone());
            items.push(json!({ "rel": v["rel"], "name": name, "from": inside, "bytes": body.len() }));
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

/// Serves a library file to CloverEye's own windows (main, w-*). Path:
/// /<sub>/<name>, URI-encoded.
pub fn protocol(ctx: UriSchemeContext<'_, tauri::Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let label = ctx.webview_label();
    if label != "main" && !label.starts_with("w-") {
        return respond_status(responder, StatusCode::FORBIDDEN);
    }
    let rel = uri_decode(request.uri().path().trim_start_matches('/'));
    let Some((sub, name)) = parse_rel(&rel) else {
        return respond_status(responder, StatusCode::NOT_FOUND);
    };
    let app = ctx.app_handle().clone();
    std::thread::spawn(move || {
        let root = app.state::<LibraryState>().root.lock().unwrap().clone();
        let Some(root) = root.or_else(|| default_root(&app).ok()) else {
            return respond_status(responder, StatusCode::NOT_FOUND);
        };
        let folder = root.join(&sub);
        let path = folder.join(&name);
        let real = std::fs::symlink_metadata(&folder).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
            && std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file());
        let Some(file) = real.then(|| std::fs::File::open(&path).ok()).flatten() else {
            return respond_status(responder, StatusCode::NOT_FOUND);
        };
        let mut buf = Vec::new();
        if file.take(MAX_FILE as u64).read_to_end(&mut buf).is_err() {
            return respond_status(responder, StatusCode::INTERNAL_SERVER_ERROR);
        }
        let res = Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime(&name))
            .header(header::CONTENT_LENGTH, buf.len())
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header("X-Content-Type-Options", "nosniff")
            .body(buf);
        responder.respond(res.unwrap());
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
            collect(&base, deep, &mut v);
            v.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect::<Vec<_>>()
        };
        assert_eq!(names(false), ["a.png"]);
        assert_eq!(names(true), ["a.png", "f.gif"]);
        assert!(real_folder("relative/path").is_err());
        assert!(real_folder(base.join("a.png").to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn uri_names_decode() {
        assert_eq!(uri_decode("caf%C3%A9%20x.png"), "café x.png");
        assert_eq!(uri_decode("100%.png"), "100%.png");
        assert_eq!(uri_decode("a%2"), "a%2");
    }
}
