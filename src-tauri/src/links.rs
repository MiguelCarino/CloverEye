// Web links in posts (ui/js/link-model.js finds them): opened in the system
// browser, never in the app window. The opener plugin's own command stays
// limited to the hosts in capabilities/default.json; this one opens any
// http or https address and nothing else.

use tauri_plugin_opener::OpenerExt;

const MAX_URL: usize = 2048;

/// The address to open, or why it is refused: http or https only, a host,
/// no "user:password@" (it disguises the host), no control characters.
pub fn checked_link(raw: &str) -> Result<String, String> {
    if raw.is_empty() || raw.len() > MAX_URL || raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("Not a web address.".into());
    }
    let url = tauri::Url::parse(raw).map_err(|_| "Not a web address.".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Only http and https links open from posts.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Links with a user name or password are not opened.".into());
    }
    match url.host_str() {
        Some(h) if !h.is_empty() => Ok(url.to_string()),
        _ => Err("Not a web address.".into()),
    }
}

/// Opens a link from a post in the system browser.
#[tauri::command]
pub fn open_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
    // never the address: only its scheme and length
    let chars = url.chars().count();
    let url = checked_link(&url).inspect_err(|e| log_info!("links", "link refused", reason = e, chars = chars))?;
    let scheme = if url.starts_with("https:") { "https" } else { "http" };
    app.opener().open_url(url, None::<&str>).map_err(|e| {
        // the opener's message can hold the address ("Launcher \"xdg-open\"
        // \"https://...\" failed"): only its kind is logged
        log_warn!("links", "the system browser did not open", scheme = scheme, chars = chars, kind = opener_error_kind(&e));
        e.to_string()
    })?;
    log_debug!("links", "link opened in the system browser", scheme = scheme, chars = chars);
    Ok(())
}

/// What kind of failure an opener error is, without its text.
fn opener_error_kind(e: &tauri_plugin_opener::Error) -> String {
    match e {
        tauri_plugin_opener::Error::Io(io) => io_kind(io),
        _ => "opener".into(),
    }
}

/// An io error's kind as a word ("NotFound", "Other"...), never its message.
fn io_kind(e: &std::io::Error) -> String {
    let k = format!("{:?}", e.kind());
    if k == "Other" || k == "Uncategorized" { "launcher-failed".into() } else { k }
}

#[cfg(test)]
mod tests {
    use super::checked_link;

    #[test]
    fn opener_failures_log_a_kind_not_the_address() {
        // open 5.x builds this message from Command's Debug output
        let e = std::io::Error::other("Launcher \"xdg-open\" \"https://example.org/private/topic\" failed with ExitStatus(1024)");
        let k = super::io_kind(&e);
        assert_eq!(k, "launcher-failed");
        assert!(!k.contains("example"));
        assert_eq!(super::opener_error_kind(&tauri_plugin_opener::Error::Io(e)), "launcher-failed");
        let nf = std::io::Error::new(std::io::ErrorKind::NotFound, "xdg-open https://example.org/x");
        assert_eq!(super::io_kind(&nf), "NotFound");
    }

    #[test]
    fn web_addresses_pass() {
        assert_eq!(checked_link("https://example.org/a?b=1#c").unwrap(), "https://example.org/a?b=1#c");
        assert_eq!(checked_link("http://example.org").unwrap(), "http://example.org/");
    }

    #[test]
    fn other_schemes_and_tricks_are_refused() {
        for raw in [
            "",
            "javascript:alert(1)",
            "JAVASCRIPT:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///etc/passwd",
            "ftp://example.org/",
            "mailto:a@example.org",
            "example.org/x",
            "https://user:pass@example.org/",
            "https://user@example.org/",
            "https://example.org/a b",
            "https://example.org/\nx",
            "http://",
        ] {
            assert!(checked_link(raw).is_err(), "{raw}");
        }
        assert!(checked_link(&format!("https://example.org/{}", "x".repeat(2100))).is_err());
    }
}
