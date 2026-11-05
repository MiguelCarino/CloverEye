//! Just enough HTTP-date handling for `Retry-After` and `If-Modified-Since`:
//! the IMF-fixdate form (`Sun, 06 Nov 1994 08:49:37 GMT`), which is the only
//! one servers are allowed to send (RFC 9110 §5.6.7).

use std::time::Duration;

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Parses an IMF-fixdate into seconds since the Unix epoch.
pub fn parse_http_date(s: &str) -> Option<u64> {
    // "Sun, 06 Nov 1994 08:49:37 GMT"
    let s = s.trim();
    let (_, rest) = s.split_once(", ")?;
    let mut parts = rest.split(' ');
    let day: u32 = parts.next()?.parse().ok()?;
    let mon = parts.next()?;
    let month = MONTHS.iter().position(|m| *m == mon)? as u32 + 1;
    let year: i64 = parts.next()?.parse().ok()?;
    let time = parts.next()?;
    if parts.next()? != "GMT" || parts.next().is_some() {
        return None;
    }
    let mut t = time.split(':');
    let hh: u64 = t.next()?.parse().ok()?;
    let mm: u64 = t.next()?.parse().ok()?;
    let ss: u64 = t.next()?.parse().ok()?;
    if t.next().is_some() || !(1..=31).contains(&day) || hh > 23 || mm > 59 || ss > 60 || !(1970..=9999).contains(&year) {
        return None;
    }
    let days = u64::try_from(days_from_civil(year, month, day)).ok()?;
    days.checked_mul(86_400)?.checked_add(hh * 3600 + mm * 60 + ss)
}

/// Formats seconds since the Unix epoch as an IMF-fixdate.
pub fn format_http_date(unix: u64) -> String {
    let days = (unix / 86_400) as i64;
    let secs = unix % 86_400;
    let (y, m, d) = civil_from_days(days);
    let wd = DAYS[(days.rem_euclid(7)) as usize];
    format!(
        "{wd}, {d:02} {} {y} {:02}:{:02}:{:02} GMT",
        MONTHS[(m - 1) as usize],
        secs / 3600,
        (secs / 60) % 60,
        secs % 60
    )
}

/// `Retry-After` is either delay-seconds or an HTTP date. Dates in the past
/// mean "now" (zero). Anything unreadable is ignored (`None`).
pub fn parse_retry_after(value: &str, unix_now: u64) -> Option<Duration> {
    let v = value.trim();
    if !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) {
        return v.parse::<u64>().ok().map(Duration::from_secs);
    }
    parse_http_date(v).map(|at| Duration::from_secs(at.saturating_sub(unix_now)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_dates() {
        assert_eq!(parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT"), Some(784_111_777));
        assert_eq!(parse_http_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
        assert_eq!(parse_http_date("Wed, 04 Nov 2026 12:03:57 GMT"), Some(1_793_793_837));
        assert_eq!(format_http_date(784_111_777), "Sun, 06 Nov 1994 08:49:37 GMT");
        assert_eq!(format_http_date(1_793_793_837), "Wed, 04 Nov 2026 12:03:57 GMT");
    }

    #[test]
    fn round_trip() {
        for t in [0u64, 951_782_400, 1_709_164_800, 1_793_793_837, 4_102_444_799] {
            assert_eq!(parse_http_date(&format_http_date(t)), Some(t), "{t}");
        }
    }

    #[test]
    fn rejects_garbage() {
        for s in ["", "yesterday", "Sun, 06 Nov 1994 08:49:37 PST", "Sun, 32 Nov 1994 08:49:37 GMT",
                  "Sunday, 06-Nov-94 08:49:37 GMT", "Sun, 06 Nov 1994 25:00:00 GMT",
                  "Sun, 06 Nov 9999999999999 08:49:37 GMT", "Sun, 06 Nov 10000 08:49:37 GMT",
                  "Sun, 06 Nov 9223372036854775807 08:49:37 GMT"] {
            assert_eq!(parse_http_date(s), None, "{s}");
        }
    }

    #[test]
    fn retry_after_forms() {
        assert_eq!(parse_retry_after("120", 0), Some(Duration::from_secs(120)));
        assert_eq!(parse_retry_after(" 7 ", 0), Some(Duration::from_secs(7)));
        let now = 1_793_793_837;
        assert_eq!(
            parse_retry_after("Wed, 04 Nov 2026 12:04:27 GMT", now),
            Some(Duration::from_secs(30))
        );
        assert_eq!(parse_retry_after("Wed, 04 Nov 2026 12:00:00 GMT", now), Some(Duration::ZERO));
        assert_eq!(parse_retry_after("-5", now), None);
        assert_eq!(parse_retry_after("soon", now), None);
        // A huge year must not overflow (it panicked in debug builds).
        assert_eq!(parse_retry_after("Sun, 06 Nov 9999999999999 08:49:37 GMT", now), None);
        assert!(parse_retry_after("Fri, 31 Dec 9999 23:59:59 GMT", now).is_some());
    }
}
