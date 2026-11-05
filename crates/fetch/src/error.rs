use std::fmt;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The board code is not 1-10 lowercase letters or digits.
    InvalidBoard(String),
    /// The request never got an HTTP answer (DNS, TLS, timeout...). The
    /// queue backs off for `retry_in` before the next request.
    Transport { message: String, retry_in: Duration },
    /// 404: the board page or thread is gone (pruned or deleted).
    NotFound,
    /// 429 or 5xx: the queue holds every request back for `retry_in`.
    BackOff { status: u16, retry_in: Duration },
    /// Any other non-success status (403, an unfollowed 3xx...). The queue
    /// backs off for `retry_in` as for a 429 without `Retry-After`.
    Status { status: u16, retry_in: Duration },
    /// The same thread was asked for inside the 10 s floor and there is no
    /// cached copy to hand back.
    TooSoon { wait: Duration },
    /// The server answered 304 to a request that had no cached copy.
    NotModifiedWithoutCache,
    /// The body was not the JSON shape expected.
    Decode(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::InvalidBoard(b) => write!(f, "not a board code: {b:?}"),
            Error::Transport { message, retry_in } => {
                write!(f, "network error ({message}); retrying in {} s", retry_in.as_secs())
            }
            Error::NotFound => write!(f, "not found (404)"),
            Error::BackOff { status, retry_in } => {
                write!(f, "server asked us to slow down ({status}); waiting {} s", retry_in.as_secs())
            }
            Error::Status { status, retry_in } => {
                write!(f, "unexpected HTTP status {status}; waiting {} s", retry_in.as_secs())
            }
            Error::TooSoon { wait } => {
                write!(f, "thread updates are limited to one per 10 s; {} ms left", wait.as_millis())
            }
            Error::NotModifiedWithoutCache => write!(f, "304 without a cached copy"),
            Error::Decode(m) => write!(f, "could not read the response: {m}"),
        }
    }
}

impl std::error::Error for Error {}
