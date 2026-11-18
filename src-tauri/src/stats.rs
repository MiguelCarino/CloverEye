// The Stats pane's files: board activity samples ("boards") and, only when
// the person turned it on, their own counts ("mine"). Plain JSON in the
// app's data folder, beside nothing else and never inside settings.json
// (whose size is kept small), written atomically (offline.rs write_atomic).
//
// Several windows may record samples at once, so every write names the
// revision it was based on: the file's `rev` must still be that number, or
// the write is refused with "stats-conflict" and the UI reads the file
// again, merges what it had not stored yet and writes once more. Nothing
// here asks the site for anything.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::Value;
use tauri::Manager;

/// The board samples stay well under this (the UI prunes to 3 MiB).
const MAX_BOARDS_BYTES: usize = 4 * 1024 * 1024;
/// 90 days of counts are a few tens of KiB.
const MAX_MINE_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub struct StatsState {
    /// Each read-compare-write happens under this.
    lock: Mutex<()>,
}

/// The file and size cap for a kind of stats.
pub fn file_for(kind: &str) -> Result<(&'static str, usize), String> {
    match kind {
        "boards" => Ok(("stats-boards.json", MAX_BOARDS_BYTES)),
        "mine" => Ok(("stats-mine.json", MAX_MINE_BYTES)),
        _ => Err("unknown stats file".into()),
    }
}

fn stats_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("no data folder: {e}"))?;
    Ok(dir.join(name))
}

/// A stored file as an object, or None (missing, unreadable or not JSON:
/// stats start over rather than fail).
fn read_value(path: &std::path::Path) -> Option<Value> {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).filter(Value::is_object)
}

/// The revision of a stored object (0 for none).
pub fn rev_of(v: Option<&Value>) -> u64 {
    v.and_then(|v| v.get("rev")).and_then(Value::as_u64).unwrap_or(0)
}

/// Checks a write against the stored revision and size cap; returns the
/// new revision and the bytes to store (the object with that `rev`).
pub fn stamp(current: Option<&Value>, expected: u64, mut data: Value, max: usize) -> Result<(u64, Vec<u8>), String> {
    let Some(obj) = data.as_object_mut() else {
        return Err("stats must be a JSON object".into());
    };
    if rev_of(current) != expected {
        return Err("stats-conflict".into());
    }
    let next = expected + 1;
    obj.insert("rev".into(), Value::from(next));
    let bytes = serde_json::to_vec(&data).map_err(|e| e.to_string())?;
    if bytes.len() > max {
        return Err("the stats file is too large".into());
    }
    Ok((next, bytes))
}

/// Whether the last write of each kind ("boards", "mine") failed: a store
/// that keeps failing (a full disk) is warned about once, not on every
/// retry while the app sits idle.
static FAILING: [AtomicBool; 2] = [AtomicBool::new(false), AtomicBool::new(false)];

/// What a write's outcome changed.
#[derive(Debug, PartialEq)]
enum Change {
    /// It failed after working: worth a warning.
    Failed,
    /// It failed again: a debug line.
    Again,
    /// It worked after failing: worth an info line.
    Recovered,
    /// It worked, as before.
    Same,
}

fn outcome(flag: &AtomicBool, ok: bool) -> Change {
    match (flag.swap(!ok, Ordering::Relaxed), ok) {
        (false, false) => Change::Failed,
        (true, false) => Change::Again,
        (true, true) => Change::Recovered,
        (false, true) => Change::Same,
    }
}

fn flag_for(kind: &str) -> &'static AtomicBool {
    &FAILING[usize::from(kind == "mine")]
}

/// The log line for a failed write, once per run of failures.
fn log_failure(kind: &str, msg: &str, error: &str) {
    match outcome(flag_for(kind), false) {
        Change::Failed => log_warn!("stats", msg, kind = kind, error = error),
        _ => log_debug!("stats", msg, kind = kind, error = error, again = true),
    }
}

/// The stored stats of `kind` ("boards" or "mine"), or null.
#[tauri::command]
pub async fn stats_read(app: tauri::AppHandle, state: tauri::State<'_, StatsState>, kind: String) -> Result<Option<Value>, String> {
    let (name, _) = file_for(&kind)?;
    let path = stats_path(&app, name)?;
    let _held = state.lock.lock().map_err(|e| e.to_string())?;
    let t0 = std::time::Instant::now();
    let v = read_value(&path);
    // the warning stands with Detailed logs on too; the debug line adds to it
    if v.is_none() && path.exists() {
        log_warn!("stats", "stats file unreadable; starting over", kind = kind);
    }
    if crate::diag::detailed() {
        let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        log_debug!("stats", "stats read", kind = kind, found = v.is_some(), bytes = bytes, rev = rev_of(v.as_ref()), ms = crate::diag::ms(t0));
    }
    Ok(v)
}

/// Stores `data` as the stats of `kind` if the file is still at `rev`;
/// returns the new revision.
#[tauri::command]
pub async fn stats_write(app: tauri::AppHandle, state: tauri::State<'_, StatsState>, kind: String, data: Value, rev: u64) -> Result<u64, String> {
    let (name, max) = file_for(&kind)?;
    let path = stats_path(&app, name)?;
    let _held = state.lock.lock().map_err(|e| e.to_string())?;
    let t0 = std::time::Instant::now();
    let current = read_value(&path);
    let (next, bytes) = stamp(current.as_ref(), rev, data, max).inspect_err(|e| {
        if e == "stats-conflict" {
            log_debug!("stats", "stats write refused: another window wrote first (merging)", kind = kind, rev = rev);
        } else {
            log_failure(&kind, "stats not written", e);
        }
    })?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    }
    crate::offline::write_atomic(&path, &bytes).inspect_err(|e| log_failure(&kind, "stats file not written", &crate::diag::redact(e, &[])))?;
    if outcome(flag_for(&kind), true) == Change::Recovered {
        log_info!("stats", "stats written again after failing", kind = kind);
    }
    log_debug!("stats", "stats written", kind = kind, rev = next, bytes = bytes.len(), ms = crate::diag::ms(t0));
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_store_that_keeps_failing_is_warned_about_once() {
        let f = AtomicBool::new(false);
        assert_eq!(outcome(&f, true), Change::Same);
        assert_eq!(outcome(&f, false), Change::Failed);
        assert_eq!(outcome(&f, false), Change::Again);
        assert_eq!(outcome(&f, false), Change::Again);
        assert_eq!(outcome(&f, true), Change::Recovered);
        assert_eq!(outcome(&f, true), Change::Same);
        assert_eq!(outcome(&f, false), Change::Failed);
    }
    use serde_json::json;

    #[test]
    fn only_two_kinds_of_stats_file() {
        assert_eq!(file_for("boards").unwrap().0, "stats-boards.json");
        assert_eq!(file_for("mine").unwrap().0, "stats-mine.json");
        assert!(file_for("settings").is_err());
        assert!(file_for("../boards").is_err());
    }

    #[test]
    fn a_write_must_name_the_stored_revision() {
        let stored = json!({ "rev": 3, "boards": {} });
        assert_eq!(stamp(Some(&stored), 2, json!({}), 100).unwrap_err(), "stats-conflict");
        let (next, bytes) = stamp(Some(&stored), 3, json!({ "boards": { "g": 1 }, "rev": 99 }), 100).unwrap();
        assert_eq!(next, 4);
        let back: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back["rev"], 4);
        assert_eq!(back["boards"]["g"], 1);
        // no file yet: revision 0
        assert_eq!(stamp(None, 0, json!({}), 100).unwrap().0, 1);
        assert!(stamp(None, 1, json!({}), 100).is_err());
    }

    #[test]
    fn objects_only_and_capped() {
        assert!(stamp(None, 0, json!([1, 2]), 100).is_err());
        assert!(stamp(None, 0, json!({ "x": "a".repeat(200) }), 100).is_err());
        assert_eq!(rev_of(Some(&json!({ "rev": "7" }))), 0);
    }
}
