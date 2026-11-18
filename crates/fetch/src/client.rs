use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::de::DeserializeOwned;

use crate::clock::Clock;
use crate::endpoint::Endpoint;
use crate::error::Error;
use crate::httpdate::parse_retry_after;
use crate::models::{Archive, BoardsResponse, Catalog, Thread, ThreadsIndex};
use crate::trace::{self, LogLevel};
use crate::transport::{Request, Response, Transport};

/// The honest User-Agent: the app name and version, nothing about the user.
pub fn user_agent() -> String {
    format!("CloverEye/{}", env!("CARGO_PKG_VERSION"))
}

/// Queue limits. The floors are hard: values below them are raised to them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// Gap between the end of one request and the start of the next.
    /// Floor: 1 s (the API rule). Can only be made slower.
    pub min_interval: Duration,
    /// Gap between two network requests for the same thread. Floor: 10 s.
    pub thread_interval: Duration,
    /// First back-off delay when the server gives no `Retry-After`; doubles
    /// on each consecutive failure.
    pub backoff_base: Duration,
    /// Cap on the self-chosen exponential delay. It does not shorten a
    /// server's `Retry-After`: that is a floor (see `RETRY_AFTER_CEILING`).
    pub backoff_cap: Duration,
    /// How many responses the in-memory `Last-Modified` cache keeps.
    pub cache_entries: usize,
    /// Total body bytes the in-memory cache may hold. Least recently used
    /// entries go first; a body larger than this is not cached at all.
    pub cache_bytes: usize,
    /// While a back-off has longer than this to run, a request that would
    /// have to wait it out returns `Error::Waiting` at once instead of
    /// sleeping (no request is made either way). `None`: always wait.
    pub max_wait: Option<Duration>,
}

impl Config {
    pub const MIN_INTERVAL_FLOOR: Duration = Duration::from_secs(1);
    pub const THREAD_INTERVAL_FLOOR: Duration = Duration::from_secs(10);
    /// A server's `Retry-After` is obeyed in full up to this; only an absurd
    /// value (a broken or hostile header) is cut down to it.
    pub const RETRY_AFTER_CEILING: Duration = Duration::from_secs(24 * 60 * 60);

    /// The same config with every limit raised to its floor.
    pub fn clamped(mut self) -> Self {
        self.min_interval = self.min_interval.max(Self::MIN_INTERVAL_FLOOR);
        self.thread_interval = self.thread_interval.max(Self::THREAD_INTERVAL_FLOOR);
        self.backoff_base = self.backoff_base.max(self.min_interval);
        self.backoff_cap = self.backoff_cap.max(self.backoff_base);
        self.cache_entries = self.cache_entries.max(1);
        self
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            min_interval: Self::MIN_INTERVAL_FLOOR,
            thread_interval: Self::THREAD_INTERVAL_FLOOR,
            backoff_base: Duration::from_secs(2),
            backoff_cap: Duration::from_secs(300),
            cache_entries: 256,
            cache_bytes: 32 * 1024 * 1024,
            max_wait: None,
        }
    }
}

/// Where a body came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freshness {
    /// 200: a new body from the network.
    New,
    /// 304: revalidated; the body is the cached copy.
    NotModified,
    /// Inside the 10 s thread floor: no request was made; cached copy.
    Throttled,
}

#[derive(Debug, Clone)]
pub struct Fetched {
    pub url: String,
    pub freshness: Freshness,
    pub body: Arc<Vec<u8>>,
    pub last_modified: Option<String>,
    /// Whether the request carried `If-Modified-Since` (false when throttled).
    pub conditional: bool,
}

impl Fetched {
    pub fn json<T: DeserializeOwned>(&self) -> Result<T, Error> {
        serde_json::from_slice(&self.body).map_err(|e| Error::Decode(e.to_string()))
    }
}

#[derive(Debug)]
struct CacheEntry {
    last_modified: String,
    body: Arc<Vec<u8>>,
    used: u64,
}

#[derive(Debug, Default)]
struct State {
    /// When the previous request finished.
    last_end: Option<Duration>,
    /// No request starts before this (back-off).
    blocked_until: Duration,
    /// Consecutive 429/5xx/transport failures.
    failures: u32,
    /// Per-thread URL: when its last network request started.
    thread_last: HashMap<String, Duration>,
    cache: HashMap<String, CacheEntry>,
    /// Sum of the cached bodies' lengths.
    cache_size: usize,
    tick: u64,
    /// Counts for the periodic summary line.
    summary: Summary,
}

/// A short cut's debug line (message and fields) and the summary's fields
/// when one is due.
type ShortCut = (Option<(&'static str, Vec<(&'static str, String)>)>, Option<Vec<(&'static str, String)>>);

/// How often the queue writes its summary line (at most; only when it did
/// something since the last one).
pub const SUMMARY_EVERY: Duration = Duration::from_secs(600);

/// What the queue did since its last summary line.
#[derive(Debug, Default)]
struct Summary {
    since: Option<Duration>,
    requests: u64,
    new: u64,
    not_modified: u64,
    throttled: u64,
    not_found: u64,
    failed: u64,
    held: u64,
    bytes: u64,
    queued: Duration,
}

/// How one `get` ended, for the summary.
enum Outcome {
    New,
    NotModified,
    Throttled,
    NotFound,
    Failed,
    Held,
}

fn ms(d: Duration) -> String {
    d.as_millis().to_string()
}

/// The app's single request queue. `get` blocks the calling thread while it
/// waits for its turn; call it off the UI thread.
pub struct Client<T: Transport, C: Clock> {
    transport: T,
    clock: C,
    config: Config,
    ua: String,
    state: Mutex<State>,
    /// The queue: held while waiting for a turn and during the request.
    send: Mutex<()>,
}

impl<T: Transport, C: Clock> Client<T, C> {
    pub fn new(transport: T, clock: C, config: Config) -> Self {
        Self {
            transport,
            clock,
            config: config.clamped(),
            ua: user_agent(),
            state: Mutex::new(State::default()),
            send: Mutex::new(()),
        }
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// How long a request made now would wait for its turn.
    pub fn wait_time(&self) -> Duration {
        let st = self.lock();
        self.ready_at(&st).saturating_sub(self.clock.now())
    }

    fn ready_at(&self, st: &State) -> Duration {
        let after_last = st
            .last_end
            .map(|end| end + self.config.min_interval)
            .unwrap_or(Duration::ZERO);
        after_last.max(st.blocked_until)
    }

    /// Drops the cached copy of one URL (e.g. the thread was closed by the
    /// user, or the post it belongs to was deleted upstream).
    pub fn forget(&self, ep: &Endpoint) {
        if let Ok(url) = ep.url() {
            let mut st = self.lock();
            Self::cache_remove(&mut st, &url);
            st.thread_last.remove(&url);
        }
    }

    /// Inside the per-thread floor: the cached copy as `Throttled`, or
    /// `TooSoon` when there is none. `None` when a request may be made.
    fn thread_floor(&self, st: &mut State, url: &str) -> Option<Result<Fetched, Error>> {
        let &last = st.thread_last.get(url)?;
        let next = last + self.config.thread_interval;
        let now = self.clock.now();
        if now >= next {
            return None;
        }
        st.tick += 1;
        let tick = st.tick;
        Some(match st.cache.get_mut(url) {
            Some(c) => {
                c.used = tick;
                Ok(Fetched {
                    url: url.to_string(),
                    freshness: Freshness::Throttled,
                    body: c.body.clone(),
                    last_modified: Some(c.last_modified.clone()),
                    conditional: false,
                })
            }
            None => Err(Error::TooSoon { wait: next - now }),
        })
    }

    /// `Waiting` when the back-off has longer to run than `max_wait`.
    fn too_long(&self, st: &State) -> Option<Error> {
        let max = self.config.max_wait?;
        let wait = st.blocked_until.saturating_sub(self.clock.now());
        (wait > max).then_some(Error::Waiting { retry_in: wait })
    }

    /// Counts one outcome; the summary's fields when one is due (at most
    /// every SUMMARY_EVERY, and only after something happened).
    fn tally(&self, st: &mut State, outcome: Outcome, bytes: usize, queued: Duration) -> Option<Vec<(&'static str, String)>> {
        let now = self.clock.now();
        let s = &mut st.summary;
        let since = *s.since.get_or_insert(now);
        match outcome {
            Outcome::New => s.new += 1,
            Outcome::NotModified => s.not_modified += 1,
            Outcome::Throttled => s.throttled += 1,
            Outcome::NotFound => s.not_found += 1,
            Outcome::Failed => s.failed += 1,
            Outcome::Held => s.held += 1,
        }
        if !matches!(outcome, Outcome::Throttled | Outcome::Held) {
            s.requests += 1;
        }
        s.bytes += bytes as u64;
        s.queued += queued;
        if now.saturating_sub(since) < SUMMARY_EVERY {
            return None;
        }
        Self::summary_fields(st, now)
    }

    /// The summary's fields for what was counted since the last one (none
    /// when nothing was), and the count starts again.
    fn summary_fields(st: &mut State, now: Duration) -> Option<Vec<(&'static str, String)>> {
        let s = &st.summary;
        let since = s.since?;
        let avg_queue = if s.requests > 0 { s.queued / s.requests as u32 } else { Duration::ZERO };
        let fields = vec![
            ("minutes", (now.saturating_sub(since).as_secs() / 60).to_string()),
            ("requests", s.requests.to_string()),
            ("new", s.new.to_string()),
            ("not_modified", s.not_modified.to_string()),
            ("from_cache", s.throttled.to_string()),
            ("not_found", s.not_found.to_string()),
            ("failed", s.failed.to_string()),
            ("held_back", s.held.to_string()),
            ("bytes", s.bytes.to_string()),
            ("avg_queue_ms", ms(avg_queue)),
            ("cached", st.cache.len().to_string()),
            ("cache_bytes", st.cache_size.to_string()),
        ];
        st.summary = Summary { since: Some(now), ..Summary::default() };
        Some(fields)
    }

    /// Writes the summary line now for what the queue did since the last
    /// one, when it did anything: before a diagnostics report is made and
    /// at quit, so a short session's requests are in the log too.
    pub fn flush_summary(&self) {
        let mut st = self.lock();
        let s = &st.summary;
        let any = s.requests + s.throttled + s.held > 0;
        let due = if any { Self::summary_fields(&mut st, self.clock.now()) } else { None };
        drop(st);
        Self::summary_line(due);
    }

    /// Writes the summary line when `tally` says one is due.
    fn summary_line(fields: Option<Vec<(&'static str, String)>>) {
        if let Some(f) = fields {
            trace::emit(LogLevel::Info, "request queue summary", &f);
        }
    }

    /// The debug line for an answer served without a request (thread floor)
    /// or refused at once (back-off), and its count for the summary. The
    /// lines are written by the caller after it lets go of the state lock
    /// (`emit_short_cut`): a log write can be slow (the file starting again).
    fn short_cut(&self, st: &mut State, ep: &Endpoint, r: &Result<Fetched, Error>) -> ShortCut {
        let outcome = match r {
            Ok(_) => Outcome::Throttled,
            Err(_) => Outcome::Held,
        };
        let line = trace::detail().then(|| {
            let mut f = ep.log_fields();
            let msg = match r {
                Ok(_) => "served the cached copy (10 s thread floor)",
                Err(Error::TooSoon { wait }) => {
                    f.push(("left_ms", ms(*wait)));
                    "too soon for this thread and nothing cached"
                }
                Err(Error::Waiting { retry_in }) => {
                    f.push(("retry_s", retry_in.as_secs().max(1).to_string()));
                    f.push(("failures", st.failures.to_string()));
                    "held back: the queue is backing off"
                }
                Err(e) => {
                    f.push(("error", e.to_string()));
                    "refused before the queue"
                }
            };
            (msg, f)
        });
        (line, self.tally(st, outcome, 0, Duration::ZERO))
    }

    /// short_cut's lines, written with no lock held.
    fn emit_short_cut((line, due): ShortCut) {
        if let Some((msg, f)) = line {
            trace::emit(LogLevel::Debug, msg, &f);
        }
        Self::summary_line(due);
    }

    /// The lines for one request that went out: one at debug, and a
    /// warning for a failure (with the back-off it started).
    #[allow(clippy::too_many_arguments)]
    fn request_lines(ep: &Endpoint, out: &Result<Fetched, Error>, status: Option<u16>, bytes: usize, took: Duration, queued: Duration, conditional: bool, failures: u32) {
        let base = || {
            let mut f = ep.log_fields();
            if let Some(s) = status {
                f.push(("status", s.to_string()));
            }
            f
        };
        if trace::detail() {
            let mut f = base();
            f.push(("bytes", bytes.to_string()));
            f.push(("ms", ms(took)));
            f.push(("queued_ms", ms(queued)));
            f.push(("conditional", conditional.to_string()));
            f.push((
                "result",
                match out {
                    Ok(x) if x.freshness == Freshness::NotModified => "not-modified".into(),
                    Ok(_) => "new".into(),
                    Err(Error::NotFound) => "not-found".into(),
                    Err(_) => "failed".into(),
                },
            ));
            trace::emit(LogLevel::Debug, "request", &f);
        }
        let warn = |msg: &str, extra: Vec<(&'static str, String)>| {
            let mut f = base();
            f.extend(extra);
            f.push(("ms", ms(took)));
            f.push(("failures", failures.to_string()));
            trace::emit(LogLevel::Warn, msg, &f);
        };
        match out {
            Err(Error::Transport { message, retry_in }) => warn("request failed", vec![("error", message.clone()), ("retry_s", retry_in.as_secs().to_string())]),
            Err(Error::BackOff { retry_in, .. }) => warn("the server asked us to slow down; backing off", vec![("retry_s", retry_in.as_secs().to_string())]),
            Err(Error::Status { retry_in, .. }) => warn("unexpected HTTP status; backing off", vec![("retry_s", retry_in.as_secs().to_string())]),
            Err(Error::NotModifiedWithoutCache) => warn("304 without a cached copy", vec![]),
            _ => {}
        }
    }

    /// GETs one endpoint through the queue.
    ///
    /// Two locks: `state` covers only the bookkeeping (floors, back-off,
    /// cache) and is never held while sleeping or on the network, so a
    /// throttled read answers at once; `send` is the queue itself, held from
    /// the wait for our turn through the request, so requests still go out
    /// one at a time and spaced exactly as before.
    pub fn get(&self, ep: &Endpoint) -> Result<Fetched, Error> {
        let url = ep.url()?;
        let is_thread = ep.is_thread();
        let entered = self.clock.now();

        // Per-thread floor first: inside it, the cached copy, no request
        // and no queue.
        {
            let mut st = self.lock();
            let early = if is_thread { self.thread_floor(&mut st, &url) } else { None };
            if let Some(r) = early.or_else(|| self.too_long(&st).map(Err)) {
                let lines = self.short_cut(&mut st, ep, &r);
                drop(st);
                Self::emit_short_cut(lines);
                return r;
            }
        }

        // Our turn in the queue.
        let _turn = self.send.lock().unwrap_or_else(|p| p.into_inner());
        let (req, conditional) = loop {
            let mut st = self.lock();
            // Checked again: while we queued, a request for this thread may
            // have been made (served as Throttled, as when it was one lock),
            // or a failure may have started a long back-off.
            let early = if is_thread { self.thread_floor(&mut st, &url) } else { None };
            if let Some(r) = early.or_else(|| self.too_long(&st).map(Err)) {
                let lines = self.short_cut(&mut st, ep, &r);
                drop(st);
                Self::emit_short_cut(lines);
                return r;
            }
            let now = self.clock.now();
            let ready = self.ready_at(&st);
            if ready > now {
                // A wait the back-off sets (not the usual 1 s spacing) is
                // worth a line: the app is slowing down on purpose.
                let backing_off = st.blocked_until > now && st.blocked_until >= ready;
                let failures = st.failures;
                // Only this queue sends, and we hold it, so nothing moves
                // `ready` while we sleep without the state lock.
                drop(st);
                if backing_off {
                    let mut f = ep.log_fields();
                    f.push(("wait_ms", ms(ready - now)));
                    f.push(("failures", failures.to_string()));
                    trace::emit(LogLevel::Info, "waiting out a back-off before the next request", &f);
                }
                self.clock.sleep(ready - now);
                continue;
            }
            let mut headers = vec![
                ("User-Agent".to_string(), self.ua.clone()),
                ("Accept".to_string(), "application/json".to_string()),
            ];
            let conditional = match st.cache.get(&url) {
                Some(c) => {
                    headers.push(("If-Modified-Since".to_string(), c.last_modified.clone()));
                    true
                }
                None => false,
            };
            break (Request { url: url.clone(), headers }, conditional);
        };

        let started = self.clock.now();
        let result = self.transport.send(&req);
        let ended = self.clock.now();

        let mut st = self.lock();
        st.last_end = Some(ended);
        if is_thread {
            // The floor counts from when the request started, failed or not.
            st.thread_last.insert(url.clone(), started);
            self.prune_thread_floor(&mut st, started);
        }
        let (status, bytes) = match &result {
            Ok(r) => (Some(r.status), r.body.len()),
            Err(_) => (None, 0),
        };
        let out = match result {
            Ok(resp) => self.handle(&mut st, url, conditional, resp),
            Err(message) => {
                let retry_in = self.register_failure(&mut st, None);
                Err(Error::Transport { message, retry_in })
            }
        };
        let outcome = match &out {
            Ok(f) if f.freshness == Freshness::NotModified => Outcome::NotModified,
            Ok(_) => Outcome::New,
            Err(Error::NotFound) => Outcome::NotFound,
            Err(_) => Outcome::Failed,
        };
        let queued = started.saturating_sub(entered);
        let failures = st.failures;
        let due = self.tally(&mut st, outcome, bytes, queued);
        drop(st);
        Self::request_lines(ep, &out, status, bytes, ended.saturating_sub(started), queued, conditional, failures);
        Self::summary_line(due);
        out
    }

    fn handle(&self, st: &mut State, url: String, conditional: bool, resp: Response) -> Result<Fetched, Error> {
        match resp.status {
            200..=299 => {
                st.failures = 0;
                let last_modified = resp.header("last-modified").map(str::to_string);
                let body = Arc::new(resp.body);
                match &last_modified {
                    Some(lm) => self.cache_put(st, &url, lm.clone(), body.clone()),
                    None => Self::cache_remove(st, &url),
                }
                Ok(Fetched { url, freshness: Freshness::New, body, last_modified, conditional })
            }
            304 => {
                st.failures = 0;
                st.tick += 1;
                let tick = st.tick;
                match st.cache.get_mut(&url) {
                    Some(c) => {
                        c.used = tick;
                        Ok(Fetched {
                            url,
                            freshness: Freshness::NotModified,
                            body: c.body.clone(),
                            last_modified: Some(c.last_modified.clone()),
                            conditional,
                        })
                    }
                    None => Err(Error::NotModifiedWithoutCache),
                }
            }
            404 => {
                st.failures = 0;
                Self::cache_remove(st, &url);
                Err(Error::NotFound)
            }
            429 | 500..=599 => {
                let ra = resp
                    .header("retry-after")
                    .and_then(|v| parse_retry_after(v, self.clock.unix_now()));
                let retry_in = self.register_failure(st, ra);
                Err(Error::BackOff { status: resp.status, retry_in })
            }
            // Anything else (403 from the edge's bot check, 3xx now that
            // redirects are not followed, 418, 451...) is not a normal answer
            // either: back off the same way, so a block page is never hammered.
            s => {
                let retry_in = self.register_failure(st, None);
                Err(Error::Status { status: s, retry_in })
            }
        }
    }

    /// Records a failure and blocks the queue. Without `Retry-After` the
    /// delay is `backoff_base × 2^(n-1)`, kept between `min_interval` and
    /// `backoff_cap`. With it, the server's value is a floor: it is waited
    /// in full (at least `min_interval`), cut only at `RETRY_AFTER_CEILING`.
    fn register_failure(&self, st: &mut State, retry_after: Option<Duration>) -> Duration {
        st.failures = st.failures.saturating_add(1);
        let delay = match retry_after {
            Some(ra) => ra.max(self.config.min_interval).min(Config::RETRY_AFTER_CEILING),
            None => {
                let exp = st.failures.saturating_sub(1).min(20);
                self.config
                    .backoff_base
                    .saturating_mul(1u32 << exp)
                    .clamp(self.config.min_interval, self.config.backoff_cap)
            }
        };
        st.blocked_until = st.blocked_until.max(self.clock.now() + delay);
        delay
    }

    fn cache_remove(st: &mut State, url: &str) {
        if let Some(old) = st.cache.remove(url) {
            st.cache_size -= old.body.len();
        }
    }

    fn cache_put(&self, st: &mut State, url: &str, last_modified: String, body: Arc<Vec<u8>>) {
        Self::cache_remove(st, url);
        if body.len() > self.config.cache_bytes {
            return;
        }
        st.tick += 1;
        let used = st.tick;
        st.cache_size += body.len();
        st.cache.insert(url.to_string(), CacheEntry { last_modified, body, used });
        while st.cache.len() > self.config.cache_entries || st.cache_size > self.config.cache_bytes {
            let oldest = st
                .cache
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => Self::cache_remove(st, &k),
                None => break,
            }
        }
    }

    fn prune_thread_floor(&self, st: &mut State, now: Duration) {
        if st.thread_last.len() > 1024 {
            let keep = self.config.thread_interval;
            st.thread_last.retain(|_, t| now.saturating_sub(*t) < keep);
        }
    }

    /// GET and decode as `D`.
    pub fn get_json<D: DeserializeOwned>(&self, ep: &Endpoint) -> Result<(Freshness, D), Error> {
        let f = self.get(ep)?;
        Ok((f.freshness, f.json()?))
    }

    pub fn boards(&self) -> Result<(Freshness, BoardsResponse), Error> {
        self.get_json(&Endpoint::Boards)
    }

    pub fn catalog(&self, board: &str) -> Result<(Freshness, Catalog), Error> {
        self.get_json(&Endpoint::Catalog(board.to_string()))
    }

    pub fn threads(&self, board: &str) -> Result<(Freshness, ThreadsIndex), Error> {
        self.get_json(&Endpoint::Threads(board.to_string()))
    }

    pub fn thread(&self, board: &str, no: u64) -> Result<(Freshness, Thread), Error> {
        self.get_json(&Endpoint::Thread(board.to_string(), no))
    }

    pub fn archive(&self, board: &str) -> Result<(Freshness, Archive), Error> {
        self.get_json(&Endpoint::Archive(board.to_string()))
    }
}
