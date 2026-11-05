//! Polite live probe of the read API (C0 gate, SCOPE §1/§7).
//!
//!     cargo run -p clovereye-fetch --example probe -- --out results/probe.md [--board g] [--thumb]
//!
//! Requests, all through the one queue (≥ 1 s apart, honest User-Agent):
//!   1. boards.json
//!   2. /<board>/catalog.json
//!   3. /<board>/catalog.json again, conditional (304 expected)
//!   4. /<board>/threads.json
//!   5. one live thread
//!   6. the same thread again ≥ 10 s later, conditional
//!   7. /<board>/archive.json
//!   8. (only with --thumb) one thumbnail from i.4cdn.org, to see whether the
//!      image host answers a polite client or returns 429
//!
//! At most 8 requests, far under the 25 the C0 plan allows. Prints a table
//! and writes it as Markdown to --out.

use std::io::Write as _;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use clovereye_fetch::{
    thumb_url, user_agent, Client, Clock, Config, Endpoint, Error, Freshness, Request, Response,
    SystemClock, Transport, UreqTransport,
};

const MAX_REQUESTS: usize = 25;

#[derive(Clone)]
struct Row {
    url: String,
    status: String,
    bytes: usize,
    ms: u128,
    conditional: bool,
    note: String,
}

/// Wraps the real transport and records every request it makes.
struct Recording {
    inner: UreqTransport,
    rows: Mutex<Vec<Row>>,
}

impl Transport for Recording {
    fn send(&self, req: &Request) -> Result<Response, String> {
        {
            let n = self.rows.lock().unwrap().len();
            assert!(n < MAX_REQUESTS, "probe request budget exhausted");
        }
        let started = Instant::now();
        let result = self.inner.send(req);
        let ms = started.elapsed().as_millis();
        let conditional = req.header("If-Modified-Since").is_some();
        let row = match &result {
            Ok(r) => Row {
                url: req.url.clone(),
                status: r.status.to_string(),
                bytes: r.body.len(),
                ms,
                conditional,
                note: [
                    r.header("retry-after").map(|v| format!("retry-after {v}")),
                    r.header("cache-control").map(|v| format!("cache-control {v}")),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("; "),
            },
            Err(e) => Row {
                url: req.url.clone(),
                status: "ERR".into(),
                bytes: 0,
                ms,
                conditional,
                note: e.clone(),
            },
        };
        self.rows.lock().unwrap().push(row);
        result
    }
}

fn args() -> (String, String, bool) {
    let mut out = None;
    let mut board = "g".to_string();
    let mut thumb = false;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--out" => out = it.next(),
            "--board" => board = it.next().unwrap_or(board),
            "--thumb" => thumb = true,
            "-h" | "--help" => {
                eprintln!("usage: probe --out <file.md> [--board g] [--thumb]");
                std::process::exit(0);
            }
            other => {
                eprintln!("unknown argument {other:?}");
                std::process::exit(2);
            }
        }
    }
    match out {
        Some(o) => (o, board, thumb),
        None => {
            eprintln!("usage: probe --out <file.md> [--board g] [--thumb]");
            std::process::exit(2);
        }
    }
}

fn freshness(r: &Result<Freshness, Error>) -> String {
    match r {
        Ok(f) => format!("{f:?}"),
        Err(e) => format!("error: {e}"),
    }
}

fn main() {
    let (out, board, thumb) = args();
    if !clovereye_fetch::valid_board(&board) {
        eprintln!("not a board code: {board:?}");
        std::process::exit(2);
    }
    let net = Arc::new(Recording {
        inner: UreqTransport::new(),
        rows: Mutex::new(Vec::new()),
    });
    let clock = SystemClock::new();
    let client = Client::new(net.clone(), clock.clone(), Config::default());
    let mut notes: Vec<String> = Vec::new();

    let r = client.get(&Endpoint::Boards).map(|f| f.freshness);
    notes.push(format!("boards.json: {}", freshness(&r)));

    let cat = client.catalog(&board);
    notes.push(format!("catalog: {}", freshness(&cat.as_ref().map(|(f, _)| *f).map_err(Clone::clone))));
    let r = client.get(&Endpoint::Catalog(board.clone())).map(|f| f.freshness);
    notes.push(format!("catalog again (conditional, 304 expected): {}", freshness(&r)));

    let r = client.get(&Endpoint::Threads(board.clone())).map(|f| f.freshness);
    notes.push(format!("threads.json: {}", freshness(&r)));

    // Thumbnail URLs for the webview image-path check (no extra request:
    // they come from the catalog already fetched).
    let thumbs: Vec<String> = cat
        .as_ref()
        .map(|(_, c)| {
            c.iter()
                .flat_map(|p| p.threads.iter())
                .filter(|t| !t.sticky && !t.spoiler && !t.filedeleted)
                .filter_map(|t| t.tim.and_then(|tim| thumb_url(&board, tim).ok()))
                .take(5)
                .collect()
        })
        .unwrap_or_default();
    let live = cat.ok().and_then(|(_, c)| {
        c.iter()
            .flat_map(|p| p.threads.iter())
            .find(|t| !t.sticky && !t.closed)
            .map(|t| (t.no, t.tim))
    });
    let mut thumb_target = None;
    match live {
        Some((no, tim)) => {
            let r = client.thread(&board, no).map(|(f, _)| f);
            notes.push(format!("thread {no}: {}", freshness(&r)));
            // Wait out the thread floor so the second request goes on the wire.
            clock.sleep(Duration::from_millis(10_200));
            let r = client.thread(&board, no).map(|(f, _)| f);
            notes.push(format!("thread {no} again after 10.2 s (conditional): {}", freshness(&r)));
            thumb_target = tim;
        }
        None => notes.push("no live thread found in the catalog; thread checks skipped".into()),
    }

    let r = client.archive(&board).map(|(f, _)| f);
    notes.push(format!("archive.json: {}", freshness(&r)));

    if thumb {
        match thumb_target.map(|tim| thumb_url(&board, tim)) {
            Some(Ok(url)) => {
                // Same spacing as the queue, sent straight through the transport.
                clock.sleep(client.wait_time().max(Duration::from_secs(1)));
                let req = Request {
                    url,
                    headers: vec![("User-Agent".into(), user_agent())],
                };
                let r = net.send(&req);
                notes.push(format!(
                    "thumbnail: {}",
                    match r {
                        Ok(resp) => format!("HTTP {}", resp.status),
                        Err(e) => format!("error: {e}"),
                    }
                ));
            }
            _ => notes.push("thumbnail: no thread with a file; skipped".into()),
        }
    }

    let rows = net.rows.lock().unwrap().clone();
    let mut md = String::new();
    md.push_str(&format!("# CloverEye API probe\n\nUser-Agent: `{}`  \nBoard: /{board}/  \nRequests: {}\n\n", user_agent(), rows.len()));
    md.push_str("| # | URL | Status | Bytes | ms | Conditional | Notes |\n|---|---|---|---|---|---|---|\n");
    println!("{:<3} {:<48} {:>6} {:>9} {:>6} {:<5}", "#", "url", "status", "bytes", "ms", "cond");
    for (i, r) in rows.iter().enumerate() {
        println!(
            "{:<3} {:<48} {:>6} {:>9} {:>6} {:<5}",
            i + 1,
            r.url,
            r.status,
            r.bytes,
            r.ms,
            if r.conditional { "yes" } else { "no" }
        );
        md.push_str(&format!(
            "| {} | {} | {} | {} | {} | {} | {} |\n",
            i + 1,
            r.url,
            r.status,
            r.bytes,
            r.ms,
            if r.conditional { "yes" } else { "no" },
            r.note.replace('|', "/")
        ));
    }
    md.push_str("\n## Outcome\n\n");
    for n in &notes {
        println!("- {n}");
        md.push_str(&format!("- {n}\n"));
    }
    if !thumbs.is_empty() {
        md.push_str("\n## Thumbnails for the image-path check\n\nTaken from the catalog above (no extra request):\n\n");
        for t in &thumbs {
            md.push_str(&format!("- {t}\n"));
        }
    }
    if let Some(parent) = std::path::Path::new(&out).parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    let mut f = std::fs::File::create(&out).unwrap_or_else(|e| {
        eprintln!("{out}: {e}");
        std::process::exit(1);
    });
    f.write_all(md.as_bytes()).expect("write report");
    println!("wrote {out}");
}
