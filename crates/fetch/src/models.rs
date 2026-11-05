//! Serde models for the read API. The API omits fields that don't apply
//! (no file, no subject, board without IDs...), so almost everything is an
//! `Option`. Flags arrive as `0`/`1` and are read into `bool`, missing = false.
//! Unknown fields are ignored so an API addition never breaks decoding.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};

fn flag<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum F {
        B(bool),
        I(i64),
        S(String),
    }
    Ok(match Option::<F>::deserialize(d)? {
        None => false,
        Some(F::B(b)) => b,
        Some(F::I(i)) => i != 0,
        Some(F::S(s)) => s == "1" || s.eq_ignore_ascii_case("true"),
    })
}

// ---------------------------------------------------------------- boards.json

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoardsResponse {
    pub boards: Vec<Board>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub troll_flags: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cooldowns {
    #[serde(default)]
    pub threads: u32,
    #[serde(default)]
    pub replies: u32,
    #[serde(default)]
    pub images: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Board {
    pub board: String,
    pub title: String,
    /// true = worksafe. `ws_board: 0` boards are NSFW and hidden unless the
    /// user opted in (SCOPE D6).
    #[serde(deserialize_with = "flag")]
    pub ws_board: bool,
    #[serde(default)]
    pub per_page: u32,
    #[serde(default)]
    pub pages: u32,
    #[serde(default)]
    pub max_filesize: u64,
    #[serde(default)]
    pub max_webm_filesize: u64,
    #[serde(default)]
    pub max_comment_chars: u32,
    /// Seconds.
    #[serde(default)]
    pub max_webm_duration: u32,
    #[serde(default)]
    pub bump_limit: u32,
    #[serde(default)]
    pub image_limit: u32,
    #[serde(default)]
    pub cooldowns: Cooldowns,
    #[serde(default)]
    pub meta_description: String,
    #[serde(default, deserialize_with = "flag")]
    pub is_archived: bool,
    #[serde(default, deserialize_with = "flag")]
    pub spoilers: bool,
    #[serde(default)]
    pub custom_spoilers: Option<u32>,
    #[serde(default, deserialize_with = "flag")]
    pub user_ids: bool,
    #[serde(default, deserialize_with = "flag")]
    pub country_flags: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board_flags: Option<BTreeMap<String, String>>,
    #[serde(default, deserialize_with = "flag")]
    pub code_tags: bool,
    #[serde(default, deserialize_with = "flag")]
    pub math_tags: bool,
    #[serde(default, deserialize_with = "flag")]
    pub sjis_tags: bool,
    #[serde(default, deserialize_with = "flag")]
    pub oekaki: bool,
    #[serde(default, deserialize_with = "flag")]
    pub text_only: bool,
    #[serde(default, deserialize_with = "flag")]
    pub forced_anon: bool,
    #[serde(default, deserialize_with = "flag")]
    pub webm_audio: bool,
    #[serde(default, deserialize_with = "flag")]
    pub require_subject: bool,
    #[serde(default)]
    pub min_image_width: Option<u32>,
    #[serde(default)]
    pub min_image_height: Option<u32>,
}

impl Board {
    pub fn is_worksafe(&self) -> bool {
        self.ws_board
    }
}

impl BoardsResponse {
    /// The boards a user may see: all of them with NSFW opted in, otherwise
    /// only worksafe ones.
    pub fn visible(&self, nsfw_opted_in: bool) -> impl Iterator<Item = &Board> {
        self.boards.iter().filter(move |b| nsfw_opted_in || b.ws_board)
    }

    pub fn get(&self, code: &str) -> Option<&Board> {
        self.boards.iter().find(|b| b.board == code)
    }
}

// ------------------------------------------------------------------- posts

/// One post, as it appears in thread JSON, catalog JSON (OPs, with the
/// catalog-only fields) and `last_replies`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Post {
    pub no: u64,
    /// 0 for an OP, otherwise the thread number.
    #[serde(default)]
    pub resto: u64,
    #[serde(default, deserialize_with = "flag")]
    pub sticky: bool,
    #[serde(default, deserialize_with = "flag")]
    pub closed: bool,
    #[serde(default, deserialize_with = "flag")]
    pub archived: bool,
    #[serde(default)]
    pub archived_on: Option<u64>,
    #[serde(default)]
    pub now: Option<String>,
    #[serde(default)]
    pub time: Option<u64>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub trip: Option<String>,
    /// Poster ID on boards with `user_ids`.
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub capcode: Option<String>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub country_name: Option<String>,
    #[serde(default)]
    pub board_flag: Option<String>,
    #[serde(default)]
    pub flag_name: Option<String>,
    #[serde(default)]
    pub sub: Option<String>,
    /// Comment as the API sends it: HTML with `<br>`, quote spans and links.
    #[serde(default)]
    pub com: Option<String>,
    /// Upload time in milliseconds; the media file name on `i.4cdn.org`.
    #[serde(default)]
    pub tim: Option<i64>,
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub ext: Option<String>,
    #[serde(default)]
    pub fsize: Option<u64>,
    #[serde(default)]
    pub md5: Option<String>,
    #[serde(default)]
    pub w: Option<u32>,
    #[serde(default)]
    pub h: Option<u32>,
    #[serde(default)]
    pub tn_w: Option<u32>,
    #[serde(default)]
    pub tn_h: Option<u32>,
    #[serde(default, deserialize_with = "flag")]
    pub filedeleted: bool,
    #[serde(default, deserialize_with = "flag")]
    pub spoiler: bool,
    #[serde(default)]
    pub custom_spoiler: Option<u32>,
    #[serde(default, deserialize_with = "flag")]
    pub m_img: bool,
    #[serde(default)]
    pub since4pass: Option<u32>,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub semantic_url: Option<String>,
    // OP-only counters.
    #[serde(default)]
    pub replies: Option<u32>,
    #[serde(default)]
    pub images: Option<u32>,
    #[serde(default)]
    pub unique_ips: Option<u32>,
    #[serde(default, deserialize_with = "flag")]
    pub bumplimit: bool,
    #[serde(default, deserialize_with = "flag")]
    pub imagelimit: bool,
    // Catalog-only.
    #[serde(default)]
    pub omitted_posts: Option<u32>,
    #[serde(default)]
    pub omitted_images: Option<u32>,
    #[serde(default)]
    pub last_modified: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_replies: Option<Vec<Post>>,
}

impl Post {
    pub fn is_op(&self) -> bool {
        self.resto == 0
    }

    pub fn has_file(&self) -> bool {
        self.tim.is_some() && self.ext.is_some() && !self.filedeleted
    }
}

/// `/<board>/thread/<no>.json`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Thread {
    pub posts: Vec<Post>,
}

impl Thread {
    pub fn op(&self) -> Option<&Post> {
        self.posts.first()
    }
}

/// `/<board>/catalog.json`: one entry per index page.
pub type Catalog = Vec<CatalogPage>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogPage {
    pub page: u32,
    pub threads: Vec<Post>,
}

/// `/<board>/threads.json`
pub type ThreadsIndex = Vec<ThreadsPage>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadsPage {
    pub page: u32,
    pub threads: Vec<ThreadStub>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadStub {
    pub no: u64,
    #[serde(default)]
    pub last_modified: u64,
    #[serde(default)]
    pub replies: u32,
}

/// `/<board>/archive.json`: thread numbers.
pub type Archive = Vec<u64>;
