use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::de::DeserializeOwned;

use crate::clock::Clock;
use crate::endpoint::Endpoint;
use crate::error::Error;
use crate::httpdate::parse_retry_after;
use crate::models::{Archive, BoardsResponse, Catalog, Thread, ThreadsIndex};
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
}

/// The app's single request queue. Every method blocks the calling thread
/// while it waits for its turn; call it off the UI thread.
pub struct Client<T: Transport, C: Clock> {
    transport: T,
    clock: C,
    config: Config,
    ua: String,
    state: Mutex<State>,
}

impl<T: Transport, C: Clock> Client<T, C> {
    pub fn new(transport: T, clock: C, config: Config) -> Self {
        Self {
            transport,
            clock,
            config: config.clamped(),
            ua: user_agent(),
            state: Mutex::new(State::default()),
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

    /// GETs one endpoint through the queue.
    pub fn get(&self, ep: &Endpoint) -> Result<Fetched, Error> {
        let url = ep.url()?;
        let mut st = self.lock();

        // Per-thread floor: inside it, hand back the cached copy, no request.
        if ep.is_thread() {
            if let Some(&last) = st.thread_last.get(&url) {
                let next = last + self.config.thread_interval;
                let now = self.clock.now();
                if now < next {
                    st.tick += 1;
                    let tick = st.tick;
                    return match st.cache.get_mut(&url) {
                        Some(c) => {
                            c.used = tick;
                            Ok(Fetched {
                                url,
                                freshness: Freshness::Throttled,
                                body: c.body.clone(),
                                last_modified: Some(c.last_modified.clone()),
                                conditional: false,
                            })
                        }
                        None => Err(Error::TooSoon { wait: next - now }),
                    };
                }
            }
        }

        // Global floor and back-off: wait for our turn.
        let now = self.clock.now();
        let ready = self.ready_at(&st);
        if ready > now {
            self.clock.sleep(ready - now);
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
        let req = Request { url: url.clone(), headers };

        if ep.is_thread() {
            let started = self.clock.now();
            st.thread_last.insert(url.clone(), started);
            self.prune_thread_floor(&mut st, started);
        }

        let result = self.transport.send(&req);
        st.last_end = Some(self.clock.now());

        let resp = match result {
            Ok(r) => r,
            Err(message) => {
                let retry_in = self.register_failure(&mut st, None);
                return Err(Error::Transport { message, retry_in });
            }
        };
        self.handle(&mut st, url, conditional, resp)
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
