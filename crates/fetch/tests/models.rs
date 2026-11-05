//! Model parsing against recorded fixtures (see fixtures/SOURCE.txt).

mod common;

use std::sync::Arc;

use clovereye_fetch::models::{BoardsResponse, Catalog, Post, Thread, ThreadsIndex};
use clovereye_fetch::{Client, Config, FakeClock, Freshness};
use common::*;

fn boards() -> BoardsResponse {
    serde_json::from_str(&fixture("boards.json")).expect("boards.json parses")
}

#[test]
fn boards_fixture_parses_every_board() {
    let b = boards();
    assert!(b.boards.len() >= 60, "{} boards", b.boards.len());
    for board in &b.boards {
        assert!(clovereye_fetch::valid_board(&board.board), "{}", board.board);
        assert!(!board.title.is_empty());
        assert!(board.max_filesize > 0 && board.max_webm_filesize > 0);
        assert!(board.max_comment_chars > 0);
        assert!(board.cooldowns.replies > 0);
    }
}

#[test]
fn g_has_the_limits_scope_quotes() {
    let b = boards();
    let g = b.get("g").expect("/g/");
    assert_eq!(g.title, "Technology");
    assert!(g.ws_board && g.is_worksafe());
    assert_eq!(g.max_webm_filesize, 4 * 1024 * 1024);
    assert_eq!(g.max_webm_duration, 120);
    assert!(!g.webm_audio, "/g/ has no WebM sound");
    assert!(g.code_tags);
    assert!(!g.math_tags);
    assert!(g.is_archived);
    assert_eq!(g.cooldowns.threads, 600);
}

#[test]
fn wsg_and_gif_allow_sound() {
    let b = boards();
    let wsg = b.get("wsg").unwrap();
    assert!(wsg.ws_board && wsg.webm_audio);
    assert_eq!(wsg.max_webm_filesize, 6 * 1024 * 1024);
    assert_eq!(wsg.max_webm_duration, 400);
    let gif = b.get("gif").unwrap();
    assert!(!gif.ws_board, "/gif/ is NSFW");
    assert!(gif.webm_audio);
    assert_eq!(gif.max_webm_duration, 300);
}

#[test]
fn optional_board_fields_are_read_where_present() {
    let b = boards();
    assert!(b.boards.iter().any(|x| x.math_tags), "some board has math_tags");
    assert!(b.boards.iter().any(|x| x.user_ids));
    assert!(b.boards.iter().any(|x| x.country_flags));
    assert!(b.boards.iter().any(|x| x.require_subject));
    assert!(b.boards.iter().any(|x| x.min_image_width.is_some()));
    assert!(b.boards.iter().any(|x| x.board_flags.as_ref().is_some_and(|f| !f.is_empty())));
    assert!(b.boards.iter().any(|x| x.spoilers));
}

#[test]
fn nsfw_boards_are_hidden_unless_opted_in() {
    let b = boards();
    let all = b.boards.len();
    let ws = b.visible(false).count();
    assert!(ws > 0 && ws < all);
    assert!(b.visible(false).all(|x| x.ws_board));
    assert_eq!(b.visible(true).count(), all);
    assert!(b.visible(false).all(|x| x.board != "gif"));
}

#[test]
fn boards_round_trip_through_serde() {
    let b = boards();
    let again: BoardsResponse = serde_json::from_str(&serde_json::to_string(&b).unwrap()).unwrap();
    assert_eq!(b, again);
}

#[test]
fn catalog_page_one_parses() {
    let c: Catalog = serde_json::from_str(&fixture("g-catalog-page1.json")).unwrap();
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].page, 1);
    assert_eq!(c[0].threads.len(), 15);
    for t in &c[0].threads {
        assert!(t.is_op());
        assert!(t.no > 0);
        assert!(t.time.is_some() && t.now.is_some());
        assert!(t.replies.is_some() && t.images.is_some());
        assert!(t.last_modified.is_some());
        assert!(t.semantic_url.is_some());
        for r in t.last_replies.iter().flatten() {
            assert_eq!(r.resto, t.no, "last_replies belong to their thread");
            assert!(r.last_replies.is_none());
        }
    }
    assert!(c[0].threads.iter().any(|t| t.has_file()));
    assert!(c[0].threads.iter().any(|t| t.sub.is_some()));
}

#[test]
fn derived_thread_parses() {
    let t: Thread = serde_json::from_str(&fixture("g-thread-derived.json")).unwrap();
    let op = t.op().unwrap();
    assert!(op.is_op());
    assert!(t.posts.len() >= 2);
    for p in &t.posts[1..] {
        assert_eq!(p.resto, op.no);
        assert!(p.no > op.no);
    }
    let with_file: Vec<&Post> = t.posts.iter().filter(|p| p.has_file()).collect();
    for p in with_file {
        assert!(p.w.unwrap() > 0 && p.h.unwrap() > 0);
        assert!(p.tn_w.is_some() && p.tn_h.is_some() && p.fsize.is_some());
        assert_eq!(p.md5.as_ref().unwrap().len(), 24, "base64 md5");
    }
}

#[test]
fn synthetic_thread_covers_the_rarer_fields() {
    let t: Thread = serde_json::from_str(&fixture("synthetic-thread.json")).unwrap();
    let op = &t.posts[0];
    assert!(op.sticky && op.closed && op.archived);
    assert_eq!(op.archived_on, Some(1_793_900_000));
    assert_eq!(op.country.as_deref(), Some("MX"));
    assert_eq!(op.id.as_deref(), Some("Ab3dE6fG"));
    assert_eq!(op.tim, Some(1_793_880_000_123));
    assert_eq!(op.unique_ips, Some(2));
    assert_eq!(op.tag.as_deref(), Some("Other"));
    let r1 = &t.posts[1];
    assert_eq!(r1.trip.as_deref(), Some("!Abc123xyz"));
    assert_eq!(r1.board_flag.as_deref(), Some("PI"));
    assert_eq!(r1.flag_name.as_deref(), Some("Pirate"));
    assert!(!r1.has_file());
    let r2 = &t.posts[2];
    assert!(r2.spoiler);
    assert_eq!(r2.custom_spoiler, Some(2));
    assert_eq!(r2.capcode.as_deref(), Some("mod"));
    assert!(r2.has_file());
    let r3 = &t.posts[3];
    assert!(r3.filedeleted && r3.m_img);
    assert!(!r3.has_file());
}

#[test]
fn flags_accept_bools_and_ignore_unknown_fields() {
    let p: Post = serde_json::from_str(r#"{"no":5,"sticky":true,"closed":0,"brand_new_field":[1,2]}"#).unwrap();
    assert!(p.sticky && !p.closed);
    let p: Post = serde_json::from_str(r#"{"no":6}"#).unwrap();
    assert_eq!(p.resto, 0);
    assert!(p.com.is_none() && p.tim.is_none() && !p.sticky);
}

#[test]
fn threads_index_and_archive_parse() {
    let idx: ThreadsIndex =
        serde_json::from_str(r#"[{"page":1,"threads":[{"no":1,"last_modified":1793880000,"replies":3}]}]"#).unwrap();
    assert_eq!(idx[0].threads[0].replies, 3);
    let arc: Vec<u64> = serde_json::from_str("[1,2,3]").unwrap();
    assert_eq!(arc.len(), 3);
}

#[test]
fn typed_helpers_decode_through_the_queue() {
    let clock = Arc::new(FakeClock::new(T0));
    let net = Arc::new(FakeTransport::new(clock.clone()));
    let c = Client::new(net.clone(), clock.clone(), Config::default());
    net.push(ok_lm(&fixture("boards.json"), "Thu, 19 Mar 2026 16:38:15 GMT"));
    net.push(ok_lm(&fixture("g-catalog-page1.json"), "Wed, 04 Nov 2026 12:03:57 GMT"));
    net.push(resp(304, &[], b""));
    net.push(ok_lm(&fixture("g-thread-derived.json"), "Wed, 04 Nov 2026 12:03:57 GMT"));
    let (f, b) = c.boards().unwrap();
    assert_eq!(f, Freshness::New);
    assert!(b.get("g").is_some());
    let (_, cat) = c.catalog("g").unwrap();
    let (f, cat2) = c.catalog("g").unwrap();
    assert_eq!(f, Freshness::NotModified);
    assert_eq!(cat, cat2);
    let no = cat[0].threads.iter().find(|t| !t.sticky).unwrap().no;
    let (_, thread) = c.thread("g", no).unwrap();
    assert_eq!(thread.op().unwrap().no, no);
}

#[test]
fn decode_errors_are_reported_not_panicked() {
    let clock = Arc::new(FakeClock::new(T0));
    let net = Arc::new(FakeTransport::new(clock.clone()));
    let c = Client::new(net.clone(), clock, Config::default());
    net.push(ok("<html>not json</html>"));
    assert!(matches!(c.boards(), Err(clovereye_fetch::Error::Decode(_))));
}
