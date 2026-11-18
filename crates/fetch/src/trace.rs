//! What the queue did, for the app's diagnostics log (src-tauri diag.rs).
//!
//! The crate has no logger of its own: the app hands it one function
//! ([`set_log_sink`]) and says whether detailed lines are wanted
//! ([`set_log_detail`]). Without a sink nothing is formatted at all.
//! Lines never carry a query string, a cookie or a response body: only the
//! endpoint's kind, board and thread number, status codes, sizes, counts
//! and durations.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

/// How much a line matters. `Debug` lines are made only with detail on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
}

/// Receives each line: level, area ("net"), message and its fields.
pub type LogSink = fn(LogLevel, &str, &str, &[(&str, String)]);

static SINK: RwLock<Option<LogSink>> = RwLock::new(None);
static DETAIL: AtomicBool = AtomicBool::new(false);

/// Where the queue's lines go (the app's diagnostics log). Replaces any
/// sink set before.
pub fn set_log_sink(sink: LogSink) {
    *SINK.write().unwrap_or_else(|e| e.into_inner()) = Some(sink);
}

/// Turns the per-request (debug) lines on or off.
pub fn set_log_detail(on: bool) {
    DETAIL.store(on, Ordering::Relaxed);
}

/// Whether debug lines are wanted (and a sink is there to take them).
pub(crate) fn detail() -> bool {
    DETAIL.load(Ordering::Relaxed) && SINK.read().map(|s| s.is_some()).unwrap_or(false)
}

/// Hands one line to the sink. Debug lines are dropped unless detail is on.
pub(crate) fn emit(level: LogLevel, msg: &str, fields: &[(&str, String)]) {
    if level == LogLevel::Debug && !DETAIL.load(Ordering::Relaxed) {
        return;
    }
    let sink = *SINK.read().unwrap_or_else(|e| e.into_inner());
    if let Some(f) = sink {
        f(level, "net", msg, fields);
    }
}
