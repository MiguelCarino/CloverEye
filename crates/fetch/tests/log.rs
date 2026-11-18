//! The queue's log lines: what they say and what they never carry. Each
//! test reads only the lines its own thread made (the client runs on the
//! caller's thread). No network.

mod common;

use std::cell::RefCell;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use clovereye_fetch::{set_log_detail, set_log_sink, Client, Config, Endpoint, FakeClock, LogLevel};
use common::*;

thread_local! {
    static LINES: RefCell<Vec<(LogLevel, String)>> = const { RefCell::new(Vec::new()) };
}

fn sink(level: LogLevel, area: &str, msg: &str, fields: &[(&str, String)]) {
    let f: Vec<String> = fields.iter().map(|(k, v)| format!("{k}={v}")).collect();
    LINES.with(|l| l.borrow_mut().push((level, format!("{area}: {msg} {}", f.join(" ")))));
}

fn take() -> Vec<(LogLevel, String)> {
    LINES.with(|l| std::mem::take(&mut *l.borrow_mut()))
}

type TestClient = Client<Arc<FakeTransport>, Arc<FakeClock>>;

/// The detail switch is global: these tests take turns.
static SERIAL: Mutex<()> = Mutex::new(());

fn setup() -> (Arc<FakeClock>, Arc<FakeTransport>, TestClient) {
    set_log_sink(sink);
    let clock = Arc::new(FakeClock::new(T0));
    let net = Arc::new(FakeTransport::new(clock.clone()).with_latency(Duration::from_millis(120)));
    let client = Client::new(net.clone(), clock.clone(), Config { max_wait: Some(Duration::from_secs(15)), ..Config::default() });
    (clock, net, client)
}

#[test]
fn every_line_names_the_endpoint_never_its_address_or_body() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (clock, net, c) = setup();
    set_log_detail(true);
    take();
    net.push(ok_lm(r#"{"posts":[{"no":1,"com":"secret words"}]}"#, "Wed, 04 Nov 2026 11:00:00 GMT"));
    c.get(&Endpoint::Thread("g".into(), 1)).unwrap();
    // inside the 10 s floor: the cached copy, a debug line, no request
    c.get(&Endpoint::Thread("g".into(), 1)).unwrap();
    clock.advance(Duration::from_secs(11));
    net.push(resp(304, &[], b""));
    c.get(&Endpoint::Thread("g".into(), 1)).unwrap();
    let lines = take();
    let text: Vec<&str> = lines.iter().map(|(_, l)| l.as_str()).collect();
    assert_eq!(lines.len(), 3, "{text:?}");
    assert!(lines.iter().all(|(lv, _)| *lv == LogLevel::Debug), "{text:?}");
    assert!(text[0].starts_with("net: request kind=thread board=g thread=1 status=200 bytes="), "{}", text[0]);
    assert!(text[0].contains(" ms=120 ") && text[0].contains("result=new"), "{}", text[0]);
    assert!(text[1].contains("cached copy"), "{}", text[1]);
    assert!(text[2].contains("status=304") && text[2].contains("conditional=true") && text[2].contains("result=not-modified"), "{}", text[2]);
    for l in &text {
        assert!(!l.contains("4cdn") && !l.contains("secret"), "{l}");
    }
    set_log_detail(false);
}

#[test]
fn without_detail_a_success_writes_nothing_and_a_failure_one_warning() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (_, net, c) = setup();
    set_log_detail(false);
    take();
    net.push(ok("[]"));
    c.get(&Endpoint::Catalog("g".into())).unwrap();
    assert!(take().is_empty(), "no line per request at the default level");
    net.push(resp(429, &[("Retry-After", "30")], b""));
    assert!(c.get(&Endpoint::Catalog("v".into())).is_err());
    let lines = take();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0].0, LogLevel::Warn);
    assert!(lines[0].1.contains("slow down") && lines[0].1.contains("status=429") && lines[0].1.contains("retry_s=30") && lines[0].1.contains("failures=1"), "{}", lines[0].1);
    // held back at once while the back-off runs: debug only, so nothing now
    assert!(c.get(&Endpoint::Catalog("a".into())).is_err());
    assert!(take().is_empty());
}

#[test]
fn a_held_back_request_says_how_long_with_detail_on() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (_, net, c) = setup();
    set_log_detail(true);
    take();
    net.push(Err("connection reset".into()));
    assert!(c.get(&Endpoint::Boards).is_err());
    net.push(resp(503, &[("Retry-After", "60")], b""));
    // the transport back-off (2 s) is under max_wait: slept out, with a line
    assert!(c.get(&Endpoint::Boards).is_err());
    assert!(c.get(&Endpoint::Boards).is_err()); // 60 s left: held back
    let lines = take();
    let text: Vec<&str> = lines.iter().map(|(_, l)| l.as_str()).collect();
    assert!(text.iter().any(|l| l.contains("request failed") && l.contains("error=connection reset")), "{text:?}");
    assert!(lines.iter().any(|(lv, l)| *lv == LogLevel::Info && l.contains("waiting out a back-off") && l.contains("wait_ms=2000")), "{text:?}");
    assert!(text.iter().any(|l| l.contains("held back") && l.contains("retry_s=60")), "{text:?}");
    set_log_detail(false);
}

#[test]
fn a_summary_at_most_every_ten_minutes() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (clock, net, c) = setup();
    set_log_detail(false);
    take();
    for _ in 0..5 {
        net.push(ok("[]"));
        c.get(&Endpoint::Catalog("g".into())).unwrap();
        clock.advance(Duration::from_secs(100));
    }
    // the fifth went out at about 400 s: no summary yet
    let lines = take();
    assert!(lines.is_empty(), "{lines:?}");
    clock.advance(Duration::from_secs(100));
    net.push(ok("[]"));
    c.get(&Endpoint::Catalog("g".into())).unwrap();
    let lines = take();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0].0, LogLevel::Info);
    assert!(lines[0].1.contains("request queue summary") && lines[0].1.contains("requests=6") && lines[0].1.contains("new=6") && lines[0].1.contains("bytes=12"), "{}", lines[0].1);
    // right after one, none
    net.push(ok("[]"));
    clock.advance(Duration::from_secs(5));
    c.get(&Endpoint::Catalog("g".into())).unwrap();
    assert!(take().is_empty());
}

#[test]
fn a_short_session_writes_its_summary_when_asked() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (clock, net, c) = setup();
    set_log_detail(false);
    take();
    // nothing counted yet: nothing to say
    c.flush_summary();
    assert!(take().is_empty());
    net.push(ok("[]"));
    c.get(&Endpoint::Catalog("g".into())).unwrap();
    clock.advance(Duration::from_secs(30));
    net.push(resp(404, &[], b""));
    let _ = c.get(&Endpoint::Catalog("zz".into()));
    take();
    // well under ten minutes, as before a report or at quit
    c.flush_summary();
    let lines = take();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0].0, LogLevel::Info);
    assert!(lines[0].1.contains("request queue summary") && lines[0].1.contains("requests=2") && lines[0].1.contains("new=1"), "{}", lines[0].1);
    // and the count starts again
    c.flush_summary();
    assert!(take().is_empty());
}
