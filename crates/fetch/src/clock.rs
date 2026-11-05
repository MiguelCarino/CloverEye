use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Time source for the queue. `now` is monotonic; `unix_now` is wall-clock
/// seconds, used only to turn a `Retry-After` HTTP date into a delay.
pub trait Clock: Send + Sync {
    fn now(&self) -> Duration;
    fn sleep(&self, d: Duration);
    fn unix_now(&self) -> u64;
}

impl<T: Clock + ?Sized> Clock for Arc<T> {
    fn now(&self) -> Duration {
        (**self).now()
    }
    fn sleep(&self, d: Duration) {
        (**self).sleep(d)
    }
    fn unix_now(&self) -> u64 {
        (**self).unix_now()
    }
}

/// The real clock.
#[derive(Debug, Clone)]
pub struct SystemClock {
    start: Instant,
}

impl SystemClock {
    pub fn new() -> Self {
        Self { start: Instant::now() }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn now(&self) -> Duration {
        self.start.elapsed()
    }
    fn sleep(&self, d: Duration) {
        std::thread::sleep(d)
    }
    fn unix_now(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}

/// A clock for tests: `sleep` advances time instantly and is recorded.
#[derive(Debug)]
pub struct FakeClock {
    inner: Mutex<FakeState>,
}

#[derive(Debug)]
struct FakeState {
    now: Duration,
    unix_start: u64,
    sleeps: Vec<Duration>,
}

impl FakeClock {
    /// `unix_start` is the wall-clock second that `now() == 0` maps to.
    pub fn new(unix_start: u64) -> Self {
        Self {
            inner: Mutex::new(FakeState {
                now: Duration::ZERO,
                unix_start,
                sleeps: Vec::new(),
            }),
        }
    }

    pub fn advance(&self, d: Duration) {
        let mut s = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        s.now += d;
    }

    /// Every sleep the queue asked for, in order.
    pub fn sleeps(&self) -> Vec<Duration> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .sleeps
            .clone()
    }
}

impl Clock for FakeClock {
    fn now(&self) -> Duration {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).now
    }
    fn sleep(&self, d: Duration) {
        let mut s = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        s.now += d;
        s.sleeps.push(d);
    }
    fn unix_now(&self) -> u64 {
        let s = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        s.unix_start + s.now.as_secs()
    }
}
