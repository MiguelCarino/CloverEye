use crate::Error;

/// The read API host. JSON only; media lives on `i.4cdn.org` and is loaded
/// by the webview with plain `<img>`/`<video>` tags, not through this queue.
pub const API_BASE: &str = "https://a.4cdn.org";
const MEDIA_BASE: &str = "https://i.4cdn.org";

/// The read API endpoints CloverEye uses.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Endpoint {
    Boards,
    Catalog(String),
    Threads(String),
    /// One index page, 1-based.
    Page(String, u32),
    Thread(String, u64),
    Archive(String),
}

/// A board code is 1-10 lowercase ASCII letters or digits (`g`, `3`, `vip`).
pub fn valid_board(b: &str) -> bool {
    (1..=10).contains(&b.len()) && b.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn board(b: &str) -> Result<&str, Error> {
    if valid_board(b) {
        Ok(b)
    } else {
        Err(Error::InvalidBoard(b.to_string()))
    }
}

impl Endpoint {
    pub fn url(&self) -> Result<String, Error> {
        Ok(match self {
            Endpoint::Boards => format!("{API_BASE}/boards.json"),
            Endpoint::Catalog(b) => format!("{API_BASE}/{}/catalog.json", board(b)?),
            Endpoint::Threads(b) => format!("{API_BASE}/{}/threads.json", board(b)?),
            Endpoint::Page(b, n) => {
                if *n == 0 {
                    return Err(Error::InvalidBoard(format!("{b} page 0")));
                }
                format!("{API_BASE}/{}/{n}.json", board(b)?)
            }
            Endpoint::Thread(b, no) => format!("{API_BASE}/{}/thread/{no}.json", board(b)?),
            Endpoint::Archive(b) => format!("{API_BASE}/{}/archive.json", board(b)?),
        })
    }

    /// Thread JSON is held to the 10 s per-thread floor.
    pub fn is_thread(&self) -> bool {
        matches!(self, Endpoint::Thread(..))
    }
}

/// Full-size file URL: `https://i.4cdn.org/<board>/<tim><ext>`.
pub fn media_url(board_code: &str, tim: i64, ext: &str) -> Result<String, Error> {
    let ext_ok = ext.len() <= 6 && ext.starts_with('.') && ext[1..].bytes().all(|c| c.is_ascii_alphanumeric());
    if !ext_ok {
        return Err(Error::Decode(format!("bad file extension {ext:?}")));
    }
    Ok(format!("{MEDIA_BASE}/{}/{tim}{ext}", board(board_code)?))
}

/// Thumbnail URL: `https://i.4cdn.org/<board>/<tim>s.jpg`.
pub fn thumb_url(board_code: &str, tim: i64) -> Result<String, Error> {
    Ok(format!("{MEDIA_BASE}/{}/{tim}s.jpg", board(board_code)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(Endpoint::Boards.url().unwrap(), "https://a.4cdn.org/boards.json");
        assert_eq!(Endpoint::Catalog("g".into()).url().unwrap(), "https://a.4cdn.org/g/catalog.json");
        assert_eq!(Endpoint::Thread("g".into(), 123).url().unwrap(), "https://a.4cdn.org/g/thread/123.json");
        assert_eq!(Endpoint::Page("vip".into(), 2).url().unwrap(), "https://a.4cdn.org/vip/2.json");
        assert_eq!(Endpoint::Archive("3".into()).url().unwrap(), "https://a.4cdn.org/3/archive.json");
        assert_eq!(media_url("g", 1700000000123, ".webm").unwrap(), "https://i.4cdn.org/g/1700000000123.webm");
        assert_eq!(thumb_url("g", 1).unwrap(), "https://i.4cdn.org/g/1s.jpg");
    }

    #[test]
    fn rejects_bad_boards() {
        for b in ["", "G", "../g", "g/", "g?x=1", "abcdefghijk", "g h", "ü"] {
            assert!(!valid_board(b), "{b:?}");
            assert!(Endpoint::Catalog(b.into()).url().is_err());
        }
        assert!(Endpoint::Page("g".into(), 0).url().is_err());
        assert!(media_url("g", 1, ".webm?x").is_err());
        assert!(media_url("g", 1, "webm").is_err());
    }

    #[test]
    fn only_threads_have_the_thread_floor() {
        assert!(Endpoint::Thread("g".into(), 1).is_thread());
        assert!(!Endpoint::Catalog("g".into()).is_thread());
        assert!(!Endpoint::Boards.is_thread());
    }
}
