//! CloverEye's fetch layer for the 4chan read API (SCOPE §1, §4.1).
//!
//! Everything the app reads from `a.4cdn.org` goes through one [`Client`]:
//!
//! * **one queue** for the whole app: requests are serialised behind a mutex,
//!   so there are never parallel bursts;
//! * a **hard floor of 1 request per second** between requests (it can be
//!   configured slower, never faster);
//! * a **10 second floor per thread**: asking for the same thread sooner
//!   returns the cached copy without touching the network;
//! * **conditional requests**: every cached response is revalidated with
//!   `If-Modified-Since`, and a `304` hands back the cached body;
//! * **back-off** on `429`, `5xx`, any other unexpected status (403, an
//!   unfollowed 3xx...) and transport errors. A server's `Retry-After`
//!   (seconds or an HTTP date) is waited in full; only the self-chosen
//!   exponential delay is capped (five minutes by default);
//! * **no redirects followed**: a follow-up GET would skip the queue;
//! * a **memory-only cache** bounded by entry count and total bytes;
//! * an honest `User-Agent: CloverEye/<version>` and nothing else that
//!   identifies the user.
//!
//! The network and the clock are traits ([`Transport`], [`Clock`]) so the
//! limits are tested with a fake clock and recorded fixtures, never live.

mod client;
mod clock;
mod endpoint;
mod error;
mod httpdate;
pub mod models;
mod transport;

pub use client::{user_agent, Client, Config, Fetched, Freshness};
pub use clock::{Clock, FakeClock, SystemClock};
pub use endpoint::{media_url, thumb_url, valid_board, Endpoint, API_BASE};
pub use error::Error;
pub use httpdate::{format_http_date, parse_http_date, parse_retry_after};
pub use transport::{Request, Response, Transport, UreqTransport};

/// The default client: real network, real clock.
pub type LiveClient = Client<UreqTransport, SystemClock>;

/// Builds the default client with the default (and minimum) limits.
pub fn live_client() -> LiveClient {
    Client::new(UreqTransport::new(), SystemClock::new(), Config::default())
}
