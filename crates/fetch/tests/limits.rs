//! Queue limits with a fake clock and a scripted transport. No network.

mod common;

use std::sync::Arc;
use std::time::Duration;

use clovereye_fetch::{Client, Clock, Config, Endpoint, Error, FakeClock, Freshness};
use common::*;

type TestClient = Client<Arc<FakeTransport>, Arc<FakeClock>>;

fn setup(config: Config) -> (Arc<FakeClock>, Arc<FakeTransport>, TestClient) {
    let clock = Arc::new(FakeClock::new(T0));
    let net = Arc::new(FakeTransport::new(clock.clone()));
    let client = Client::new(net.clone(), clock.clone(), config);
    (clock, net, client)
}

fn gaps(times: &[Duration]) -> Vec<Duration> {
    times.windows(2).map(|w| w[1] - w[0]).collect()
}

fn cat(b: &str) -> Endpoint {
    Endpoint::Catalog(b.to_string())
}

fn thread(no: u64) -> Endpoint {
    Endpoint::Thread("g".to_string(), no)
}

// ------------------------------------------------------------- global floor

#[test]
fn back_to_back_requests_are_one_second_apart() {
    let (_, net, c) = setup(Config::default());
    for _ in 0..6 {
        net.push(ok("[]"));
    }
    for b in ["g", "v", "a", "tv", "sci", "diy"] {
        c.get(&cat(b)).unwrap();
    }
    let times = net.send_times();
    assert_eq!(times.len(), 6);
    assert_eq!(times[0], Duration::ZERO, "the first request does not wait");
    for g in gaps(&times) {
        assert!(g >= S(1), "gap {g:?} under the 1 s floor");
    }
}

#[test]
fn floor_counts_from_the_end_of_the_previous_request() {
    let clock = Arc::new(FakeClock::new(T0));
    let net = Arc::new(FakeTransport::new(clock.clone()).with_latency(MS(700)));
    let c = Client::new(net.clone(), clock.clone(), Config::default());
    net.push(ok("[]"));
    net.push(ok("[]"));
    c.get(&cat("g")).unwrap();
    c.get(&cat("v")).unwrap();
    let t = net.send_times();
    assert_eq!(t[1] - t[0], MS(1700), "700 ms latency + 1 s gap");
}

#[test]
fn no_wait_when_the_caller_was_already_idle() {
    let (clock, net, c) = setup(Config::default());
    net.push(ok("[]"));
    net.push(ok("[]"));
    c.get(&cat("g")).unwrap();
    clock.advance(S(5));
    assert_eq!(c.wait_time(), Duration::ZERO);
    c.get(&cat("v")).unwrap();
    assert!(clock.sleeps().is_empty(), "idle for 5 s, so no sleep: {:?}", clock.sleeps());
}

#[test]
fn wait_time_reports_the_remaining_gap() {
    let (clock, net, c) = setup(Config::default());
    net.push(ok("[]"));
    c.get(&cat("g")).unwrap();
    clock.advance(MS(400));
    assert_eq!(c.wait_time(), MS(600));
}

#[test]
fn faster_than_one_per_second_is_clamped() {
    let cfg = Config {
        min_interval: MS(100),
        thread_interval: S(2),
        ..Config::default()
    };
    let (_, net, c) = setup(cfg);
    assert_eq!(c.config().min_interval, S(1));
    assert_eq!(c.config().thread_interval, S(10));
    for _ in 0..3 {
        net.push(ok("[]"));
    }
    for b in ["g", "v", "a"] {
        c.get(&cat(b)).unwrap();
    }
    for g in gaps(&net.send_times()) {
        assert!(g >= S(1), "{g:?}");
    }
}

#[test]
fn slower_interval_is_honoured() {
    let cfg = Config {
        min_interval: MS(2500),
        ..Config::default()
    };
    let (_, net, c) = setup(cfg);
    for _ in 0..3 {
        net.push(ok("[]"));
    }
    for b in ["g", "v", "a"] {
        c.get(&cat(b)).unwrap();
    }
    assert_eq!(gaps(&net.send_times()), vec![MS(2500), MS(2500)]);
}

#[test]
fn queue_is_shared_across_threads() {
    let (_, net, c) = setup(Config::default());
    for _ in 0..8 {
        net.push(ok("[]"));
    }
    let c = Arc::new(c);
    let handles: Vec<_> = ["g", "v", "a", "tv", "sci", "diy", "o", "ck"]
        .into_iter()
        .map(|b| {
            let c = c.clone();
            std::thread::spawn(move || c.get(&cat(b)).unwrap())
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    let mut times = net.send_times();
    times.sort();
    assert_eq!(times.len(), 8);
    for g in gaps(&times) {
        assert!(g >= S(1), "parallel callers still queue: {g:?}");
    }
}

// ------------------------------------------------------------- thread floor

#[test]
fn same_thread_inside_ten_seconds_is_served_from_cache() {
    let (clock, net, c) = setup(Config::default());
    net.push(ok_lm(r#"{"posts":[{"no":1}]}"#, "Wed, 04 Nov 2026 12:00:00 GMT"));
    let first = c.get(&thread(1)).unwrap();
    assert_eq!(first.freshness, Freshness::New);

    clock.advance(S(3));
    let second = c.get(&thread(1)).unwrap();
    assert_eq!(second.freshness, Freshness::Throttled);
    assert!(!second.conditional);
    assert_eq!(second.body, first.body);
    assert_eq!(net.sent().len(), 1, "no request inside the thread floor");

    clock.advance(MS(6999)); // 9.999 s after the first request
    assert_eq!(c.get(&thread(1)).unwrap().freshness, Freshness::Throttled);
    assert_eq!(net.sent().len(), 1);
}

#[test]
fn same_thread_after_ten_seconds_is_conditional() {
    let (clock, net, c) = setup(Config::default());
    let lm = "Wed, 04 Nov 2026 12:00:00 GMT";
    net.push(ok_lm(r#"{"posts":[{"no":1}]}"#, lm));
    net.push(resp(304, &[], b""));
    c.get(&thread(1)).unwrap();
    clock.advance(S(10));
    let again = c.get(&thread(1)).unwrap();
    assert_eq!(again.freshness, Freshness::NotModified);
    let sent = net.sent();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[1].0 - sent[0].0, S(10));
    assert_eq!(sent[1].1.header("If-Modified-Since"), Some(lm));
}

#[test]
fn thread_floor_is_per_thread() {
    let (_, net, c) = setup(Config::default());
    net.push(ok_lm(r#"{"posts":[{"no":1}]}"#, "Wed, 04 Nov 2026 12:00:00 GMT"));
    net.push(ok_lm(r#"{"posts":[{"no":2}]}"#, "Wed, 04 Nov 2026 12:00:00 GMT"));
    c.get(&thread(1)).unwrap();
    let other = c.get(&thread(2)).unwrap();
    assert_eq!(other.freshness, Freshness::New, "a different thread is not throttled");
    assert_eq!(gaps(&net.send_times()), vec![S(1)], "but still obeys the global floor");
}

#[test]
fn thread_floor_without_cache_says_how_long_to_wait() {
    let (clock, net, c) = setup(Config::default());
    // A response without Last-Modified is not cached.
    net.push(ok(r#"{"posts":[{"no":1}]}"#));
    c.get(&thread(1)).unwrap();
    clock.advance(S(4));
    assert_eq!(c.get(&thread(1)).unwrap_err(), Error::TooSoon { wait: S(6) });
    assert_eq!(net.sent().len(), 1);
}

#[test]
fn thread_floor_counts_failed_requests_too() {
    let (clock, net, c) = setup(Config::default());
    net.push(Err("connection reset".into()));
    assert!(matches!(c.get(&thread(1)), Err(Error::Transport { .. })));
    clock.advance(S(3));
    assert!(matches!(c.get(&thread(1)), Err(Error::TooSoon { .. })));
    assert_eq!(net.sent().len(), 1);
}

#[test]
fn catalog_is_not_held_to_the_thread_floor() {
    let (_, net, c) = setup(Config::default());
    net.push(ok_lm("[]", "Wed, 04 Nov 2026 12:00:00 GMT"));
    net.push(resp(304, &[], b""));
    c.get(&cat("g")).unwrap();
    assert_eq!(c.get(&cat("g")).unwrap().freshness, Freshness::NotModified);
    assert_eq!(gaps(&net.send_times()), vec![S(1)]);
}

// --------------------------------------------------------------------- 304

#[test]
fn not_modified_returns_the_cached_body() {
    let (_, net, c) = setup(Config::default());
    let lm = "Wed, 04 Nov 2026 12:03:57 GMT";
    net.push(ok_lm(r#"{"boards":[]}"#, lm));
    net.push(resp(304, &[("Last-Modified", lm)], b""));
    let a = c.get(&Endpoint::Boards).unwrap();
    assert!(!a.conditional, "nothing cached yet, so no If-Modified-Since");
    assert_eq!(net.sent()[0].1.header("If-Modified-Since"), None);
    let b = c.get(&Endpoint::Boards).unwrap();
    assert_eq!(b.freshness, Freshness::NotModified);
    assert!(b.conditional);
    assert_eq!(&*b.body, br#"{"boards":[]}"#);
    assert_eq!(b.last_modified.as_deref(), Some(lm));
    assert_eq!(net.sent()[1].1.header("If-Modified-Since"), Some(lm));
}

#[test]
fn a_new_body_replaces_the_cache_and_its_date() {
    let (_, net, c) = setup(Config::default());
    net.push(ok_lm("[1]", "Wed, 04 Nov 2026 12:00:00 GMT"));
    net.push(ok_lm("[1,2]", "Wed, 04 Nov 2026 12:00:30 GMT"));
    net.push(resp(304, &[], b""));
    let ep = Endpoint::Archive("g".into());
    c.get(&ep).unwrap();
    assert_eq!(c.get(&ep).unwrap().freshness, Freshness::New);
    let third = c.get(&ep).unwrap();
    assert_eq!(&*third.body, b"[1,2]");
    assert_eq!(net.sent()[2].1.header("If-Modified-Since"), Some("Wed, 04 Nov 2026 12:00:30 GMT"));
}

#[test]
fn not_modified_without_a_cached_copy_is_an_error() {
    let (_, net, c) = setup(Config::default());
    net.push(resp(304, &[], b""));
    assert_eq!(c.get(&cat("g")).unwrap_err(), Error::NotModifiedWithoutCache);
}

#[test]
fn not_found_drops_the_cached_copy() {
    let (clock, net, c) = setup(Config::default());
    net.push(ok_lm(r#"{"posts":[{"no":1}]}"#, "Wed, 04 Nov 2026 12:00:00 GMT"));
    net.push(resp(404, &[], b""));
    net.push(resp(404, &[], b""));
    c.get(&thread(1)).unwrap();
    clock.advance(S(10));
    assert_eq!(c.get(&thread(1)).unwrap_err(), Error::NotFound);
    clock.advance(S(10));
    c.get(&thread(1)).unwrap_err();
    assert_eq!(net.sent()[2].1.header("If-Modified-Since"), None, "404 cleared the cache");
    assert!(clock.sleeps().is_empty(), "404 is not a back-off");
}

#[test]
fn forget_drops_cache_and_thread_floor() {
    let (_, net, c) = setup(Config::default());
    net.push(ok_lm(r#"{"posts":[{"no":1}]}"#, "Wed, 04 Nov 2026 12:00:00 GMT"));
    net.push(ok_lm(r#"{"posts":[{"no":1}]}"#, "Wed, 04 Nov 2026 12:00:00 GMT"));
    c.get(&thread(1)).unwrap();
    c.forget(&thread(1));
    let again = c.get(&thread(1)).unwrap();
    assert_eq!(again.freshness, Freshness::New);
    assert!(!again.conditional);
}

#[test]
fn cache_is_bounded() {
    let cfg = Config {
        cache_entries: 2,
        ..Config::default()
    };
    let (_, net, c) = setup(cfg);
    for _ in 0..4 {
        net.push(ok_lm("[]", "Wed, 04 Nov 2026 12:00:00 GMT"));
    }
    c.get(&cat("a")).unwrap();
    c.get(&cat("b")).unwrap();
    c.get(&cat("c")).unwrap(); // evicts a
    c.get(&cat("a")).unwrap();
    assert_eq!(net.sent()[3].1.header("If-Modified-Since"), None, "a was evicted");
}

#[test]
fn cache_is_bounded_by_bytes() {
    let cfg = Config {
        cache_bytes: 10,
        ..Config::default()
    };
    let (_, net, c) = setup(cfg);
    let lm = "Wed, 04 Nov 2026 12:00:00 GMT";
    net.push(ok_lm("[1,2]", lm)); // a: 5 bytes
    net.push(ok_lm("[3,4]", lm)); // b: 5 bytes, total 10
    net.push(ok_lm("[5,6]", lm)); // c: evicts a (least recently used)
    net.push(ok_lm("[1,2,3,4,5,6]", lm)); // d: 13 bytes, larger than the budget
    net.push(ok_lm("[]", lm)); // b again
    net.push(ok_lm("[]", lm)); // a again
    net.push(ok_lm("[]", lm)); // d again
    for b in ["a", "b", "c", "d", "b", "a", "d"] {
        c.get(&cat(b)).unwrap();
    }
    let sent = net.sent();
    assert_eq!(sent[4].1.header("If-Modified-Since"), Some(lm), "b stayed");
    assert_eq!(sent[5].1.header("If-Modified-Since"), None, "a was evicted by c");
    assert_eq!(sent[6].1.header("If-Modified-Since"), None, "an oversized body is not cached");
}

// ----------------------------------------------------------------- back-off

#[test]
fn too_many_requests_without_retry_after_backs_off_exponentially() {
    let (clock, net, c) = setup(Config::default());
    for _ in 0..4 {
        net.push(resp(429, &[], b""));
    }
    net.push(ok("[]"));
    net.push(ok("[]"));
    let mut delays = Vec::new();
    for _ in 0..4 {
        match c.get(&cat("g")) {
            Err(Error::BackOff { status: 429, retry_in }) => delays.push(retry_in),
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(delays, vec![S(2), S(4), S(8), S(16)]);
    assert_eq!(gaps(&net.send_times()), vec![S(2), S(4), S(8)], "each retry waited its delay");
    c.get(&cat("g")).unwrap();
    assert_eq!(*gaps(&net.send_times()).last().unwrap(), S(16));
    // Success resets the failure count: next gap is the plain 1 s floor.
    c.get(&cat("v")).unwrap();
    assert_eq!(*gaps(&net.send_times()).last().unwrap(), S(1));
    assert!(clock.now() >= S(31));
}

#[test]
fn backoff_is_capped() {
    let cfg = Config {
        backoff_cap: S(60),
        ..Config::default()
    };
    let (_, net, c) = setup(cfg);
    for _ in 0..10 {
        net.push(resp(503, &[], b""));
    }
    let mut last = Duration::ZERO;
    for _ in 0..10 {
        if let Err(Error::BackOff { retry_in, .. }) = c.get(&cat("g")) {
            last = retry_in;
            assert!(retry_in <= S(60));
        } else {
            panic!("expected back-off");
        }
    }
    assert_eq!(last, S(60));
}

#[test]
fn retry_after_seconds_is_honoured() {
    let (_, net, c) = setup(Config::default());
    net.push(resp(429, &[("Retry-After", "30")], b""));
    net.push(ok("[]"));
    assert_eq!(
        c.get(&cat("g")).unwrap_err(),
        Error::BackOff { status: 429, retry_in: S(30) }
    );
    c.get(&cat("g")).unwrap();
    assert_eq!(gaps(&net.send_times()), vec![S(30)]);
}

#[test]
fn retry_after_http_date_is_honoured() {
    let (_, net, c) = setup(Config::default());
    // T0 is 12:00:00; the server says 12:00:45.
    net.push(resp(503, &[("Retry-After", "Wed, 04 Nov 2026 12:00:45 GMT")], b""));
    net.push(ok("[]"));
    assert_eq!(
        c.get(&cat("g")).unwrap_err(),
        Error::BackOff { status: 503, retry_in: S(45) }
    );
    c.get(&cat("g")).unwrap();
    assert_eq!(gaps(&net.send_times()), vec![S(45)]);
}

#[test]
fn retry_after_is_a_floor_not_capped_by_backoff_cap() {
    let (_, net, c) = setup(Config::default());
    net.push(resp(429, &[("Retry-After", "3600")], b""));
    net.push(resp(429, &[("Retry-After", "0")], b""));
    net.push(resp(429, &[("Retry-After", "whenever")], b""));
    net.push(resp(429, &[("Retry-After", "99999999")], b""));
    // The server asked for an hour: the queue waits the whole hour, not
    // backoff_cap (300 s).
    assert_eq!(c.get(&cat("g")).unwrap_err(), Error::BackOff { status: 429, retry_in: S(3600) });
    assert_eq!(c.get(&cat("g")).unwrap_err(), Error::BackOff { status: 429, retry_in: S(1) });
    // Unreadable header: falls back to exponential (third failure: 2 × 4).
    assert_eq!(c.get(&cat("g")).unwrap_err(), Error::BackOff { status: 429, retry_in: S(8) });
    // Only an absurd value is cut, to the 24 h ceiling.
    assert_eq!(
        c.get(&cat("g")).unwrap_err(),
        Error::BackOff { status: 429, retry_in: Config::RETRY_AFTER_CEILING }
    );
    assert_eq!(gaps(&net.send_times()), vec![S(3600), S(1), S(8)]);
}

#[test]
fn garbled_retry_after_date_does_not_panic_and_still_backs_off() {
    let (_, net, c) = setup(Config::default());
    net.push(resp(429, &[("Retry-After", "Sun, 06 Nov 9999999999999 08:49:37 GMT")], b""));
    net.push(ok("[]"));
    assert_eq!(c.get(&cat("g")).unwrap_err(), Error::BackOff { status: 429, retry_in: S(2) });
    c.get(&cat("g")).unwrap();
    assert_eq!(gaps(&net.send_times()), vec![S(2)]);
}

#[test]
fn backoff_holds_every_endpoint_not_just_the_one_that_failed() {
    let (_, net, c) = setup(Config::default());
    net.push(resp(429, &[("Retry-After", "20")], b""));
    net.push(ok("[]"));
    c.get(&cat("g")).unwrap_err();
    c.get(&Endpoint::Boards).unwrap();
    assert_eq!(gaps(&net.send_times()), vec![S(20)]);
}

#[test]
fn transport_errors_back_off_too() {
    let (_, net, c) = setup(Config::default());
    net.push(Err("dns failure".into()));
    net.push(Err("timeout".into()));
    net.push(ok("[]"));
    assert!(matches!(c.get(&cat("g")), Err(Error::Transport { retry_in, .. }) if retry_in == S(2)));
    assert!(matches!(c.get(&cat("g")), Err(Error::Transport { retry_in, .. }) if retry_in == S(4)));
    c.get(&cat("g")).unwrap();
    assert_eq!(gaps(&net.send_times()), vec![S(2), S(4)]);
}

#[test]
fn other_statuses_back_off_too() {
    let (_, net, c) = setup(Config::default());
    net.push(resp(403, &[], b""));
    net.push(resp(403, &[], b""));
    net.push(resp(302, &[("Location", "https://example.invalid/")], b""));
    net.push(ok("[]"));
    net.push(ok("[]"));
    assert_eq!(c.get(&cat("g")).unwrap_err(), Error::Status { status: 403, retry_in: S(2) });
    assert_eq!(c.get(&cat("g")).unwrap_err(), Error::Status { status: 403, retry_in: S(4) });
    // A redirect is not followed; it is a failed answer like any other.
    assert_eq!(c.get(&cat("g")).unwrap_err(), Error::Status { status: 302, retry_in: S(8) });
    c.get(&cat("g")).unwrap();
    // Success resets the count: back to the 1 s floor.
    c.get(&cat("v")).unwrap();
    assert_eq!(gaps(&net.send_times()), vec![S(2), S(4), S(8), S(1)]);
    assert_eq!(net.sent().len(), 5, "no extra request for the redirect target");
}

// ------------------------------------------------------------------ headers

#[test]
fn user_agent_is_honest_and_nothing_else_identifies_the_user() {
    let (_, net, c) = setup(Config::default());
    net.push(ok("[]"));
    c.get(&cat("g")).unwrap();
    let (_, req) = &net.sent()[0];
    let ua = req.header("User-Agent").unwrap();
    assert_eq!(ua, format!("CloverEye/{}", env!("CARGO_PKG_VERSION")));
    assert_eq!(req.header("Accept"), Some("application/json"));
    let names: Vec<_> = req.headers.iter().map(|(k, _)| k.to_ascii_lowercase()).collect();
    assert_eq!(names, vec!["user-agent", "accept"]);
    assert_eq!(req.url, "https://a.4cdn.org/g/catalog.json");
}

#[test]
fn invalid_board_never_reaches_the_network() {
    let (_, net, c) = setup(Config::default());
    assert!(matches!(c.get(&cat("../etc")), Err(Error::InvalidBoard(_))));
    assert!(net.sent().is_empty());
}
