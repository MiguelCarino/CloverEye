#![allow(dead_code)]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use clovereye_fetch::{Clock, FakeClock, Request, Response, Transport};

/// Wall-clock second that fake time zero maps to (Wed, 04 Nov 2026 12:00:00 GMT).
pub const T0: u64 = 1_793_793_600;

pub type Reply = Result<Response, String>;

/// Scripted transport: hands out replies in order and records every request
/// with the fake time it was sent.
pub struct FakeTransport {
    clock: Arc<FakeClock>,
    replies: Mutex<VecDeque<Reply>>,
    sent: Mutex<Vec<(Duration, Request)>>,
    /// Simulated network latency, applied to the fake clock per request.
    latency: Duration,
}

impl FakeTransport {
    pub fn new(clock: Arc<FakeClock>) -> Self {
        Self {
            clock,
            replies: Mutex::new(VecDeque::new()),
            sent: Mutex::new(Vec::new()),
            latency: Duration::ZERO,
        }
    }

    pub fn with_latency(mut self, d: Duration) -> Self {
        self.latency = d;
        self
    }

    pub fn push(&self, r: Reply) {
        self.replies.lock().unwrap().push_back(r);
    }

    pub fn sent(&self) -> Vec<(Duration, Request)> {
        self.sent.lock().unwrap().clone()
    }

    pub fn send_times(&self) -> Vec<Duration> {
        self.sent().into_iter().map(|(t, _)| t).collect()
    }
}

impl Transport for FakeTransport {
    fn send(&self, req: &Request) -> Result<Response, String> {
        self.sent.lock().unwrap().push((self.clock.now(), req.clone()));
        self.clock.advance(self.latency);
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("no scripted reply for {}", req.url))
    }
}

pub fn resp(status: u16, headers: &[(&str, &str)], body: &[u8]) -> Reply {
    Ok(Response {
        status,
        headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        body: body.to_vec(),
    })
}

pub fn ok_lm(body: &str, last_modified: &str) -> Reply {
    resp(200, &[("Last-Modified", last_modified), ("Content-Type", "application/json")], body.as_bytes())
}

pub fn ok(body: &str) -> Reply {
    resp(200, &[("Content-Type", "application/json")], body.as_bytes())
}

pub fn fixture(name: &str) -> String {
    let p = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{p}: {e}"))
}

pub const S: fn(u64) -> Duration = Duration::from_secs;
pub const MS: fn(u64) -> Duration = Duration::from_millis;
