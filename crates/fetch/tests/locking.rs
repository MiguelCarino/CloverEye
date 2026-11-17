//! The queue's two locks: a throttled read never waits behind a sleep or a
//! request, while requests themselves stay one at a time and spaced as
//! before. Fake clock, scripted transport, no network.

mod common;

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use clovereye_fetch::{Client, Clock, Config, Endpoint, Error, FakeClock, Freshness, Request, Response, Transport};
use common::*;

fn cat(b: &str) -> Endpoint {
    Endpoint::Catalog(b.to_string())
}

fn thread(no: u64) -> Endpoint {
    Endpoint::Thread("g".to_string(), no)
}

const LM: &str = "Wed, 04 Nov 2026 12:00:00 GMT";

/// A transport whose `send` can be held open: it reports that a request
/// started and waits for a go before answering (after `hold()`).
struct HeldTransport {
    inner: FakeTransport,
    hold: Mutex<Option<(Sender<()>, Receiver<()>)>>,
}

impl HeldTransport {
    fn new(clock: Arc<FakeClock>) -> Self {
        Self { inner: FakeTransport::new(clock), hold: Mutex::new(None) }
    }

    /// The next `send` reports on the returned receiver, then waits on the
    /// returned sender's go.
    fn hold(&self) -> (Receiver<()>, Sender<()>) {
        let (started_tx, started_rx) = channel();
        let (go_tx, go_rx) = channel();
        *self.hold.lock().unwrap() = Some((started_tx, go_rx));
        (started_rx, go_tx)
    }
}

impl Transport for HeldTransport {
    fn send(&self, req: &Request) -> Result<Response, String> {
        let held = self.hold.lock().unwrap().take();
        if let Some((started, go)) = held {
            started.send(()).unwrap();
            go.recv().unwrap();
        }
        self.inner.send(req)
    }
}

/// A clock whose `sleep` can be held open the same way.
struct HeldClock {
    inner: Arc<FakeClock>,
    hold: Mutex<Option<(Sender<Duration>, Receiver<()>)>>,
}

impl HeldClock {
    fn hold(&self) -> (Receiver<Duration>, Sender<()>) {
        let (started_tx, started_rx) = channel();
        let (go_tx, go_rx) = channel();
        *self.hold.lock().unwrap() = Some((started_tx, go_rx));
        (started_rx, go_tx)
    }
}

impl Clock for HeldClock {
    fn now(&self) -> Duration {
        self.inner.now()
    }
    fn sleep(&self, d: Duration) {
        let held = self.hold.lock().unwrap().take();
        if let Some((started, go)) = held {
            started.send(d).unwrap();
            go.recv().unwrap();
        }
        self.inner.sleep(d)
    }
    fn unix_now(&self) -> u64 {
        self.inner.unix_now()
    }
}

const PATIENCE: Duration = Duration::from_secs(5);

#[test]
fn a_throttled_read_answers_while_another_request_is_on_the_network() {
    let clock = Arc::new(FakeClock::new(T0));
    let net = Arc::new(HeldTransport::new(clock.clone()));
    let c = Arc::new(Client::new(net.clone(), clock.clone(), Config::default()));
    net.inner.push(ok_lm(r#"{"posts":[{"no":1}]}"#, LM));
    net.inner.push(ok("[]"));
    c.get(&thread(1)).unwrap();
    clock.advance(S(3));

    let (started, go) = net.hold();
    let slow = {
        let c = c.clone();
        std::thread::spawn(move || c.get(&cat("v")))
    };
    started.recv_timeout(PATIENCE).expect("the catalog request started");

    // The catalog request is still under way; the thread read must not wait.
    let (tx, rx) = channel();
    {
        let c = c.clone();
        std::thread::spawn(move || tx.send(c.get(&thread(1)).map(|f| f.freshness)).unwrap());
    }
    let got = rx.recv_timeout(PATIENCE).expect("a throttled read waits behind a request");
    assert_eq!(got, Ok(Freshness::Throttled));
    assert_eq!(c.wait_time(), Duration::ZERO, "wait_time does not block either");

    go.send(()).unwrap();
    slow.join().unwrap().unwrap();
    assert_eq!(net.inner.sent().len(), 2);
}

#[test]
fn a_throttled_read_answers_while_another_caller_sleeps_out_a_back_off() {
    let fake = Arc::new(FakeClock::new(T0));
    let clock = Arc::new(HeldClock { inner: fake.clone(), hold: Mutex::new(None) });
    let net = Arc::new(FakeTransport::new(fake.clone()));
    let c = Arc::new(Client::new(net.clone(), clock.clone(), Config::default()));
    net.push(ok_lm(r#"{"posts":[{"no":1}]}"#, LM));
    net.push(resp(503, &[("Retry-After", "3600")], b""));
    net.push(ok("[]"));
    c.get(&thread(1)).unwrap();
    fake.advance(S(1));
    assert_eq!(c.get(&cat("g")).unwrap_err(), Error::BackOff { status: 503, retry_in: S(3600) });

    let (sleeping, go) = clock.hold();
    let waiter = {
        let c = c.clone();
        std::thread::spawn(move || c.get(&cat("v")))
    };
    assert_eq!(sleeping.recv_timeout(PATIENCE).unwrap(), S(3600), "the catalog waits out the hour");

    let (tx, rx) = channel();
    {
        let c = c.clone();
        std::thread::spawn(move || tx.send(c.get(&thread(1)).map(|f| f.freshness)).unwrap());
    }
    let got = rx.recv_timeout(PATIENCE).expect("a throttled read waits behind a sleep");
    assert_eq!(got, Ok(Freshness::Throttled));

    go.send(()).unwrap();
    waiter.join().unwrap().unwrap();
    let t = net.send_times();
    assert_eq!(t[2] - t[1], S(3600), "the back-off was still waited in full");
}

#[test]
fn a_long_back_off_answers_at_once_when_max_wait_is_set() {
    let clock = Arc::new(FakeClock::new(T0));
    let net = Arc::new(FakeTransport::new(clock.clone()));
    let cfg = Config { max_wait: Some(S(15)), ..Config::default() };
    let c = Client::new(net.clone(), clock.clone(), cfg);
    net.push(resp(503, &[("Retry-After", "3600")], b""));
    net.push(ok("[]"));
    assert_eq!(c.get(&cat("g")).unwrap_err(), Error::BackOff { status: 503, retry_in: S(3600) });

    // No request and no sleep: the caller hears how long is left.
    assert_eq!(c.get(&cat("v")).unwrap_err(), Error::Waiting { retry_in: S(3600) });
    clock.advance(S(600));
    assert_eq!(c.get(&Endpoint::Boards).unwrap_err(), Error::Waiting { retry_in: S(3000) });
    assert_eq!(net.sent().len(), 1);
    assert!(clock.sleeps().is_empty(), "{:?}", clock.sleeps());

    // Within max_wait of the end, the request waits its turn as usual.
    clock.advance(S(2990));
    c.get(&cat("v")).unwrap();
    assert_eq!(clock.sleeps(), vec![S(10)]);
    assert_eq!(net.send_times()[1] - net.send_times()[0], S(3600), "never sooner than the server asked");
}

#[test]
fn short_back_offs_are_still_slept_with_max_wait_set() {
    let clock = Arc::new(FakeClock::new(T0));
    let net = Arc::new(FakeTransport::new(clock.clone()));
    let cfg = Config { max_wait: Some(S(15)), ..Config::default() };
    let c = Client::new(net.clone(), clock.clone(), cfg);
    net.push(Err("dns failure".into()));
    net.push(Err("timeout".into()));
    net.push(ok("[]"));
    assert!(matches!(c.get(&cat("g")), Err(Error::Transport { .. })));
    assert!(matches!(c.get(&cat("g")), Err(Error::Transport { .. })));
    c.get(&cat("g")).unwrap();
    let t = net.send_times();
    assert_eq!(vec![t[1] - t[0], t[2] - t[1]], vec![S(2), S(4)]);
}

#[test]
fn a_queued_caller_rechecks_the_back_off_after_its_turn_comes() {
    // A caller that queued before a failure must not then sleep out a long
    // back-off: it is answered with Waiting once its turn comes.
    let clock = Arc::new(FakeClock::new(T0));
    let net = Arc::new(HeldTransport::new(clock.clone()));
    let cfg = Config { max_wait: Some(S(15)), ..Config::default() };
    let c = Arc::new(Client::new(net.clone(), clock.clone(), cfg));
    net.inner.push(resp(429, &[("Retry-After", "600")], b""));

    let (started, go) = net.hold();
    let first = {
        let c = c.clone();
        std::thread::spawn(move || c.get(&cat("g")))
    };
    started.recv_timeout(PATIENCE).unwrap();
    let second = {
        let c = c.clone();
        std::thread::spawn(move || c.get(&cat("v")))
    };
    // Give the second caller time to queue behind the first (if it has not
    // yet, it sees the back-off on its first check: the same answer).
    std::thread::sleep(Duration::from_millis(50));
    go.send(()).unwrap();
    assert_eq!(first.join().unwrap().unwrap_err(), Error::BackOff { status: 429, retry_in: S(600) });
    assert_eq!(second.join().unwrap().unwrap_err(), Error::Waiting { retry_in: S(600) });
    assert_eq!(net.inner.sent().len(), 1);
}

#[test]
fn the_same_thread_asked_twice_at_once_makes_one_request() {
    let clock = Arc::new(FakeClock::new(T0));
    let net = Arc::new(HeldTransport::new(clock.clone()));
    let c = Arc::new(Client::new(net.clone(), clock.clone(), Config::default()));
    net.inner.push(ok_lm(r#"{"posts":[{"no":1}]}"#, LM));

    let (started, go) = net.hold();
    let first = {
        let c = c.clone();
        std::thread::spawn(move || c.get(&thread(1)))
    };
    started.recv_timeout(PATIENCE).unwrap();
    let second = {
        let c = c.clone();
        std::thread::spawn(move || c.get(&thread(1)))
    };
    std::thread::sleep(Duration::from_millis(50));
    go.send(()).unwrap();
    let a = first.join().unwrap().unwrap();
    let b = second.join().unwrap().unwrap();
    assert_eq!(a.freshness, Freshness::New);
    assert_eq!(b.freshness, Freshness::Throttled, "the second waits for the first and gets its body");
    assert_eq!(b.body, a.body);
    assert_eq!(net.inner.sent().len(), 1, "never two requests for one thread inside 10 s");
}

#[test]
fn waiting_says_how_long_is_left() {
    assert_eq!(
        Error::Waiting { retry_in: S(90) }.to_string(),
        "holding requests back after an error; next try in 90 s"
    );
}
